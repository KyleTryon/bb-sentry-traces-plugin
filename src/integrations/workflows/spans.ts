/**
 * The OTLP spans of a workflow run: its own spans, and a root for a run that
 * Workflows no longer has.
 */
import { span as otlpSpan, type AttributeValue, type OtlpSpan } from "../../core/otlp.js";
import { scrub } from "../../core/scrub/cut.js";
import { identifier } from "../../core/text.js";
import { MAX_ERROR } from "../../core/trace/types.js";
import {
  workflowAttributes,
  workflowCallSpanId,
  workflowPhaseSpanId,
  workflowRootSpanId,
  type WorkflowContext,
} from "./ids.js";
import type { WorkflowPlacement } from "./placement.js";
import type { WorkflowCall, WorkflowRunView } from "./schema.js";

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
        ? { message: captureContent && run.error ? scrub(run.error, MAX_ERROR) : "workflow failed" }
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
        ? { message: captureContent && call.error ? scrub(call.error, MAX_ERROR) : "workflow call failed" }
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
