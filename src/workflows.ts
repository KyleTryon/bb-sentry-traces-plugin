/**
 * The Workflows integration. A workflow script runs outside any thread, so
 * the only trace of it is the worker threads it spawns. Two things tie those
 * back together, both read from the bundled Workflows plugin:
 *
 * - each worker thread's Workflows metadata, which names its run, its call
 *   and the thread that started the run (no secrets are kept there);
 * - the `workflowRunView` RPC, which gives the run's phases and calls.
 *
 * That RPC is internal to the Workflows plugin and can change. Any failed read
 * means "not a workflow worker" and the thread exports on its own.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { span as otlpSpan, type AttributeValue, type OtlpSpan } from "./otlp.js";
import type { WorkflowHint } from "./providers.js";
import { scrub } from "./scrub.js";
import {
  identifier,
  workflowAttributes,
  workflowCallSpanId,
  workflowPhaseSpanId,
  workflowRootSpanId,
  type WorkflowContext,
} from "./spans.js";
import { errorMessage, record, text, type ThreadInfo } from "./util.js";

export const WORKFLOWS_PLUGIN_ID = "workflows";

const optionalText = z.string().nullish();
const optionalTime = z.number().nullish();

const callSchema = z
  .object({
    id: z.string(),
    index: z.number(),
    label: optionalText,
    phase: optionalText,
    status: z.string(),
    provider: optionalText,
    model: optionalText,
    reasoningLevel: optionalText,
    cached: z.boolean().nullish(),
    childThreadId: optionalText,
    providerRetryAttempts: z.number().nullish(),
    repairAttempts: z.number().nullish(),
    error: optionalText,
    createdAt: z.number(),
    startedAt: optionalTime,
    finishedAt: optionalTime,
  })
  .loose();

const runViewSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.string(),
    phases: z
      .array(z.object({ title: optionalText, calls: z.array(callSchema).default([]) }).loose())
      .default([]),
    unphasedCalls: z.array(callSchema).default([]),
    error: optionalText,
    createdAt: z.number(),
    startedAt: optionalTime,
    finishedAt: optionalTime,
  })
  .loose();

const runViewResultSchema = z.object({ run: runViewSchema.nullable() }).loose();

export type WorkflowRunView = z.infer<typeof runViewSchema>;
type WorkflowCall = z.infer<typeof callSchema>;

/** Run states after which Workflows does no more work on a run. */
const ENDED_STATES = new Set(["succeeded", "failed", "cancelled"]);

export function workflowEnded(run: Pick<WorkflowRunView, "status">): boolean {
  return ENDED_STATES.has(run.status);
}

/** How long to stop asking after Workflows failed to answer. */
const UNAVAILABLE_MS = 5 * 60 * 1_000;

export class WorkflowsClient {
  private unavailableUntil = 0;

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "log">,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The run, `null` when Workflows has no such run, or `undefined` when it did
   * not answer.
   */
  async runView(originThreadId: string, runId: string): Promise<WorkflowRunView | null | undefined> {
    if (this.unavailableUntil > this.now()) return undefined;
    try {
      const result = await this.bb.sdk.plugins.callRpc({
        pluginId: WORKFLOWS_PLUGIN_ID,
        method: "workflowRunView",
        input: { threadId: originThreadId, runId },
        outputSchema: runViewResultSchema,
      });
      // Parsed here too, so the schema's defaults hold whatever the transport does.
      return runViewResultSchema.parse(result).run;
    } catch (cause) {
      this.unavailableUntil = this.now() + UNAVAILABLE_MS;
      this.bb.log.debug(`Workflows workflowRunView is not available: ${errorMessage(cause)}`);
      return undefined;
    }
  }

  /** Where a worker thread sits in a workflow run, or null when it is not a worker. */
  async workerContext(thread: ThreadInfo): Promise<WorkflowContext | null> {
    if (thread.originPluginId !== WORKFLOWS_PLUGIN_ID) return null;
    let metadata: Record<string, unknown>;
    try {
      metadata = record(
        await this.bb.sdk.threads.getPluginMetadata({
          threadId: thread.id,
          pluginId: WORKFLOWS_PLUGIN_ID,
        }),
      );
    } catch (cause) {
      this.bb.log.debug(`Could not read Workflows metadata of ${thread.id}: ${errorMessage(cause)}`);
      return null;
    }
    // Any client can write thread metadata, so only well-formed values count.
    const runId = text(metadata.runId);
    const callId = text(metadata.callId);
    const originThreadId = text(metadata.originThreadId) || thread.lifecycleOwnerThreadId || "";
    if (!runId || !callId || !originThreadId) return null;

    const run = await this.runView(originThreadId, runId);
    const call = run ? allCalls(run).find((candidate) => candidate.id === callId) : undefined;
    return {
      runId,
      callId,
      originThreadId,
      name: run ? identifier(run.name) : null,
      scriptName: run?.name ?? null,
      callIndex: call?.index ?? null,
      call: call ? callFacts(call) : null,
    };
  }
}

export function allCalls(run: WorkflowRunView): WorkflowCall[] {
  return [...run.phases.flatMap((phase) => phase.calls), ...run.unphasedCalls];
}

function callFacts(call: WorkflowCall): NonNullable<WorkflowContext["call"]> {
  return {
    phase: call.phase ?? null,
    provider: call.provider ?? null,
    model: call.model ?? null,
    reasoningLevel: call.reasoningLevel ?? null,
  };
}

/** A workflow call as trace providers are told about it. */
export function workflowHint(
  run: Pick<WorkflowRunView, "id" | "name">,
  call: WorkflowCall,
  originThreadId: string,
): { threadId: string; workflow: WorkflowHint } | null {
  if (!call.childThreadId) return null;
  return {
    threadId: call.childThreadId,
    workflow: {
      runId: run.id,
      name: run.name,
      callId: call.id,
      callIndex: call.index,
      originThreadId,
      ...callFacts(call),
    },
  };
}

/** Where a workflow run's spans go: its own trace, or under a span of a provider's trace. */
export interface WorkflowPlacement {
  traceId: string;
  parentSpanId: string | null;
  /** Attributes of the enclosing provider trace, when there is one. */
  attributes: Record<string, AttributeValue>;
  /** Whether the workflow's name is the pipeline: not when the enclosing trace names one. */
  pipeline: boolean;
  /** The agent each worker thread runs as, by thread id, when a provider named it. */
  agents?: ReadonlyMap<string, { agentId: string | null; agentName: string | null }> | null;
}

/**
 * A root for a workflow run Workflows no longer has, so the worker turns
 * already sent into its trace are not left without one.
 */
export function deletedWorkflowSpans(
  context: Pick<WorkflowContext, "runId" | "originThreadId">,
  placement: WorkflowPlacement,
  seen: { from: number; to: number },
): OtlpSpan[] {
  return [
    otlpSpan({
      traceId: placement.traceId,
      spanId: workflowRootSpanId(context.runId),
      parentSpanId: placement.parentSpanId,
      name: "invoke_workflow workflow",
      start: seen.from,
      end: Math.max(seen.from, seen.to),
      attributes: {
        ...placement.attributes,
        ...workflowAttributes({ ...context, callId: null, name: null, callIndex: null }, false),
        "sentry.op": "gen_ai.invoke_workflow",
        "gen_ai.operation.name": "invoke_workflow",
        "bb.workflow.status": "deleted",
        // The run's real times went with it; these are when this plugin saw it.
        "bb.inferred": true,
      },
    }),
  ];
}

/**
 * A workflow run's own spans: the run, its phases and its calls. Worker
 * threads' turns are sent separately and hang under their call by id.
 *
 * Phase titles, call labels and error text are written by whoever wrote the
 * script, often a model, so they are sent only with content capture.
 */
export function workflowSpans(
  run: WorkflowRunView,
  originThreadId: string,
  placement: WorkflowPlacement,
  captureContent: boolean,
  now: number,
): OtlpSpan[] {
  const { traceId } = placement;
  const rootId = workflowRootSpanId(run.id);
  const name = identifier(run.name);
  const base: Record<string, AttributeValue> = {
    ...placement.attributes,
    ...workflowAttributes(
      { runId: run.id, callId: null, originThreadId, name, callIndex: null },
      placement.pipeline,
    ),
  };
  const start = run.startedAt ?? run.createdAt;
  const end = run.finishedAt ?? Math.max(now, start);
  const failed = run.status === "failed";
  const spans: OtlpSpan[] = [];

  spans.push(
    otlpSpan({
      traceId,
      spanId: rootId,
      parentSpanId: placement.parentSpanId,
      name: `invoke_workflow ${name ?? "workflow"}`,
      start,
      end,
      attributes: {
        ...base,
        "sentry.op": "gen_ai.invoke_workflow",
        "gen_ai.operation.name": "invoke_workflow",
        "bb.workflow.status": run.status,
        "error.type": failed ? "workflow_failed" : undefined,
      },
      error: failed
        ? { message: captureContent && run.error ? scrub(run.error, 300) : "workflow failed" }
        : null,
    }),
  );

  const callSpan = (call: WorkflowCall, parentSpanId: string, phaseIndex: number | null) => {
    const callStart = call.startedAt ?? call.createdAt;
    const callFailed = call.status === "failed";
    const agent = call.childThreadId ? placement.agents?.get(call.childThreadId) : undefined;
    return otlpSpan({
      traceId,
      spanId: workflowCallSpanId(run.id, call.id),
      parentSpanId,
      name: `workflow.call ${captureContent && call.label ? scrub(call.label, 120) : call.index}`,
      start: callStart,
      end: call.finishedAt ?? callStart,
      attributes: {
        ...base,
        "sentry.op": "bb.workflow.call",
        "bb.workflow.call_id": call.id,
        "bb.workflow.call.index": call.index,
        "bb.workflow.call.status": call.status,
        "bb.workflow.phase.index": phaseIndex ?? undefined,
        "bb.workflow.phase": captureContent && call.phase ? scrub(call.phase, 120) : undefined,
        // A cached call replayed an earlier result and ran no agent.
        "bb.workflow.call.cached": call.cached || undefined,
        "bb.workflow.call.thread_id": call.childThreadId,
        "bb.workflow.call.provider_retries": call.providerRetryAttempts || undefined,
        "bb.workflow.call.repairs": call.repairAttempts || undefined,
        "bb.agent.id": agent?.agentId,
        "bb.agent.name": agent?.agentName,
        "bb.provider.id": call.provider,
        "gen_ai.request.model": call.model,
        "gen_ai.request.reasoning.level": call.reasoningLevel,
        "error.type": callFailed ? "workflow_call_failed" : undefined,
      },
      error: callFailed
        ? { message: captureContent && call.error ? scrub(call.error, 300) : "workflow call failed" }
        : null,
    });
  };

  run.phases.forEach((phase, index) => {
    if (phase.calls.length === 0) return;
    const phaseId = workflowPhaseSpanId(run.id, index);
    const starts = phase.calls.map((call) => call.startedAt ?? call.createdAt);
    const ends = phase.calls.map((call) => call.finishedAt ?? call.startedAt ?? call.createdAt);
    spans.push(
      otlpSpan({
        traceId,
        spanId: phaseId,
        parentSpanId: rootId,
        name: `workflow.phase ${captureContent && phase.title ? scrub(phase.title, 120) : index + 1}`,
        start: Math.min(...starts),
        end: Math.max(...ends),
        attributes: {
          ...base,
          "sentry.op": "bb.workflow.phase",
          "bb.workflow.phase.index": index,
          "bb.workflow.phase.calls": phase.calls.length,
        },
      }),
    );
    for (const call of phase.calls) spans.push(callSpan(call, phaseId, index));
  });
  for (const call of run.unphasedCalls) spans.push(callSpan(call, rootId, null));
  return spans;
}
