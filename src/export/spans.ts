/**
 * Maps a thread's turns to the spans Sentry Agent Monitoring reads:
 *
 *   invoke_agent <agent>          one per turn
 *   ├─ chat <model>               the model's own time, inferred from gaps
 *   ├─ execute_tool <tool>        commands, tool calls, file edits, searches
 *   └─ execute_tool Agent         a handoff to a subagent (gen_ai.transfer.*)
 *       └─ invoke_agent <kind>    the subagent's run, with its own tool calls
 *
 * A thread on its own gets one trace per turn. A workflow's workers share the
 * workflow run's trace, and a thread a trace provider claims puts its turns in
 * that provider's trace.
 */
import { isToolCall, modelStretches } from "../core/breakdown.js";
import { span as otlpSpan, spanIdFor, traceIdFor, type AttributeValue, type OtlpSpan } from "../core/otlp.js";
import {
  providerSpanId,
  providerTraceId,
  traceAttributes,
} from "../integrations/providers/spans.js";
import { type TraceContext } from "../integrations/providers/types.js";
import { recap, rescrub, scrub } from "../core/scrub/cut.js";
import { SUBAGENT } from "../core/trace/builder.js";
import { MAX_ARGS, MAX_INPUT, MAX_REPLY, MAX_RESULT, type Span, type Turn } from "../core/trace/types.js";
import { usageAttributes, type SentryUsage } from "../core/usage.js";
import {
  workflowAttributes,
  workflowCallSpanId,
  workflowTraceId,
  type WorkflowContext,
} from "../integrations/workflows/ids.js";
import type { ThreadInfo } from "../thread.js";

export interface TurnUsage {
  usage: SentryUsage;
  /** How many turns the usage covers: more than one when earlier turns were never exported. */
  turns: number;
}

export interface TurnSpanOptions {
  thread: ThreadInfo;
  captureContent: boolean;
  now: number;
  /** The provider trace the turn belongs to, if any. */
  trace: TraceContext | null;
  /** Set for a workflow worker: its turns hang under its call. */
  workflow?: WorkflowContext | null;
  /** Usage for the turns that have one, by turn id. */
  usage: ReadonlyMap<string, TurnUsage>;
}

/**
 * A provider's trace holds everything in it. A workflow started outside one
 * gets a trace of its own. Any other turn is its own trace.
 */
export function turnTraceId(
  threadId: string,
  turnId: string,
  trace: TraceContext | null,
  workflow: WorkflowContext | null = null,
): string {
  if (trace) return providerTraceId(trace.provider, trace.traceKey);
  if (workflow) return workflowTraceId(workflow.runId);
  return traceIdFor(`thread/${threadId}/turn/${turnId}`);
}

const PROVIDER_NAMES: Record<string, string> = {
  "claude-code": "anthropic",
  codex: "openai",
};

/**
 * The model vendor in OpenTelemetry's names. bb's provider id names the agent
 * CLI, which is not always the vendor, so the model string decides when it can.
 */
export function genAiProvider(providerId: string | null, model: string | null): string | null {
  const name = (model ?? "").toLowerCase();
  if (/(^|[/:])claude/.test(name)) return "anthropic";
  if (/(^|[/:])(gpt|o\d|codex|chatgpt)/.test(name)) return "openai";
  if (/(^|[/:])gemini/.test(name)) return "gcp.gemini";
  if (/(^|[/:])grok/.test(name)) return "x_ai";
  if (/(^|[/:])(mistral|codestral)/.test(name)) return "mistral_ai";
  if (/(^|[/:])deepseek/.test(name)) return "deepseek";
  if (!providerId) return null;
  return PROVIDER_NAMES[providerId] ?? providerId;
}

/** The agent's name in Sentry: the one a trace provider gave, else bb's provider. */
export function agentNameFor(thread: ThreadInfo, trace: TraceContext | null): string {
  return trace?.agentName || trace?.agentId || thread.providerId || "bb-agent";
}

function messages(role: "user" | "assistant", texts: readonly string[]): string | undefined {
  const parts = texts.filter(Boolean).map((content) => ({ type: "text", content }));
  return parts.length > 0 ? JSON.stringify([{ role, parts }]) : undefined;
}

/**
 * The replies that fit the cap, newest kept first: the last reply is the
 * answer. Each keeps its end, the way the trace already cut it.
 */
function fitReplies(replies: readonly string[]): string[] {
  const kept: string[] = [];
  let room = MAX_REPLY;
  for (let index = replies.length - 1; index >= 0 && room > 0; index--) {
    const reply = rescrub(replies[index], room, "end");
    kept.unshift(reply);
    room -= reply.length;
  }
  return kept;
}

function toolSpanName(span: Span): string {
  switch (span.kind) {
    case "waiting":
      return `wait ${span.toolName}`;
    case "startup":
    case "compaction":
    case "error":
      return span.toolName;
    default:
      return `execute_tool ${span.toolName}`;
  }
}

function sentryOp(span: Span): string {
  switch (span.kind) {
    case "waiting":
      return "bb.wait";
    case "startup":
      return "bb.startup";
    case "compaction":
      return "bb.compaction";
    case "error":
      return "bb.error";
    default:
      return "gen_ai.execute_tool";
  }
}

/** The spans of one finished or running turn. */
export function turnSpans(turn: Turn, options: TurnSpanOptions): OtlpSpan[] {
  const { thread, trace, captureContent, now } = options;
  const workflow = options.workflow ?? null;
  const traceId = turnTraceId(thread.id, turn.id, trace, workflow);
  // A worker's turns hang under its workflow call; other turns of a trace where its provider says.
  const parentSpanId =
    workflow && workflow.callId
      ? workflowCallSpanId(workflow.runId, workflow.callId)
      : trace
        ? providerSpanId(trace.provider, trace.traceKey, trace.parentKey)
        : null;
  const id = (key: string) => spanIdFor(`thread/${thread.id}/turn/${turn.id}/${key}`);
  const rootId = id("turn");
  const turnEnd = turn.end ?? Math.max(now, turn.start);
  const agentName = agentNameFor(thread, trace);
  const model = turn.model ?? trace?.model ?? null;
  const provider = genAiProvider(thread.providerId, model);

  const shared: Record<string, AttributeValue> = {
    // A provider's own attributes first, so they cannot replace this plugin's.
    ...(trace ? { ...trace.attributes, ...traceAttributes(trace), "bb.agent.id": trace.agentId } : {}),
    ...(workflow ? workflowAttributes(workflow, !trace?.pipeline) : {}),
    "gen_ai.conversation.id": thread.id,
    "bb.thread.id": thread.id,
    "bb.project.id": thread.projectId,
    "bb.provider.id": thread.providerId,
    "bb.turn.id": turn.id,
    "bb.turn.index": turn.index,
    "bb.thread.title": captureContent && thread.title ? scrub(thread.title, 200) : undefined,
  };
  // The model the provider switched to mid-turn is the one that answered from then on.
  const answeredBy = (end: number) =>
    turn.fallback && end >= turn.fallback.at ? turn.fallback.model : undefined;
  const input = captureContent && turn.input ? rescrub(turn.input, MAX_INPUT) : null;
  const inputMessages = input ? messages("user", [input]) : undefined;
  const outputMessages = captureContent ? messages("assistant", fitReplies(turn.replies)) : undefined;

  const spans: OtlpSpan[] = [];
  spans.push(
    otlpSpan({
      traceId,
      spanId: rootId,
      parentSpanId,
      name: `invoke_agent ${agentName}`,
      start: turn.start,
      end: turnEnd,
      attributes: {
        ...shared,
        "sentry.op": "gen_ai.invoke_agent",
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": agentName,
        "gen_ai.request.model": model,
        "gen_ai.provider.name": provider,
        "gen_ai.response.model": answeredBy(turnEnd),
        "gen_ai.request.reasoning.level": turn.reasoningLevel,
        "bb.service_tier": turn.serviceTier,
        "bb.permission_mode": turn.permissionMode,
        "bb.model_fallback.reason": turn.fallback?.reason,
        "bb.rate_limit.status": turn.rateLimitStatus,
        "bb.context.used_tokens": turn.context?.usedTokens,
        "bb.context.window_tokens": turn.context?.windowTokens,
        "bb.turn.status": turn.status,
        "bb.turn.initiator": turn.initiator,
        "bb.turn.source": turn.source,
        "bb.turn.sender": turn.sender,
        "bb.turn.running": turn.end === null ? true : undefined,
        "bb.thread.parent_id": thread.parentThreadId,
        "bb.thread.owner_id": thread.lifecycleOwnerThreadId,
        "bb.thread.origin": thread.originKind,
        "bb.thread.origin_plugin": thread.originPluginId,
        "bb.thread.hidden": thread.visibility === "hidden" ? true : undefined,
        "bb.environment.id": thread.environmentId,
        "bb.environment.worktree": thread.isWorktree ?? undefined,
        "bb.host.id": thread.hostId,
        // bb names a branch after the thread's title, which comes from the prompt.
        "bb.environment.branch":
          captureContent && thread.branch ? scrub(thread.branch, 200) : undefined,
        "error.type": turn.status === "failed" ? "turn_failed" : undefined,
        "gen_ai.input.messages": inputMessages,
        "gen_ai.output.messages": outputMessages,
      },
      error:
        turn.status === "failed"
          ? { message: turn.error ? scrub(turn.error, 300) : "turn failed" }
          : null,
    }),
  );

  // The model's own time. bb cannot see individual model requests, so each
  // stretch between tool calls stands in for one.
  const stretches = modelStretches(turn, now);
  const turnUsage = options.usage.get(turn.id);
  if (stretches.length === 0 && turnUsage) {
    stretches.push({ start: turn.start, end: turnEnd, phases: ["model"] });
  }
  // The span with the usage goes last: a turn sent in several requests that
  // stops part way has then never sent its usage, so it can go with a later turn.
  let usageSpan: OtlpSpan | null = null;
  for (const [index, stretch] of stretches.entries()) {
    // Usage goes on exactly one span per turn, so cost is counted once.
    const last = index === stretches.length - 1;
    const usage = last ? turnUsage : undefined;
    const chat = otlpSpan({
      traceId,
      spanId: id(`chat:${index}`),
      parentSpanId: rootId,
      name: `chat ${model ?? "unknown"}`,
      client: true,
      start: stretch.start,
      end: stretch.end,
      attributes: {
        ...shared,
        "sentry.op": "gen_ai.chat",
        "gen_ai.operation.name": "chat",
        "gen_ai.agent.name": agentName,
        "gen_ai.request.model": model,
        "gen_ai.response.model": answeredBy(stretch.end),
        "gen_ai.provider.name": provider,
        "bb.inferred": true,
        "bb.phases": stretch.phases.join(","),
        ...(usage ? usageAttributes(usage.usage) : {}),
        "bb.usage.turns": usage && usage.turns > 1 ? usage.turns : undefined,
        "gen_ai.input.messages": last ? inputMessages : undefined,
        "gen_ai.output.messages": last ? outputMessages : undefined,
      },
    });
    if (usage) usageSpan = chat;
    else spans.push(chat);
  }

  const byId = new Map(turn.spans.map((span) => [span.id, span]));
  for (const span of turn.spans) {
    const isAgent = span.kind === "subagent";
    const isTool = isAgent || isToolCall(span);
    // A call inside a subagent belongs to that subagent, not to the turn's agent.
    const lane = span.parentId ? byId.get(span.parentId) : undefined;
    const caller = lane?.agent ?? agentName;
    const failed = span.status === "failed";
    const end = span.end ?? Math.max(turnEnd, span.start);
    const error = failed ? { message: span.error ? scrub(span.error, 300) : span.errorType } : null;
    const state: Record<string, AttributeValue> = {
      "error.type": span.errorType,
      "bb.span.kind": span.kind,
      "bb.span.status": span.status,
      "bb.span.background": span.background || undefined,
      "bb.span.running": span.end === null ? true : undefined,
    };
    // A subagent is a tool call that hands work to another agent: the call is
    // the record of the handoff, and the agent's own run nests under it.
    const callId = isAgent ? id(`${span.id}:call`) : id(span.id);
    spans.push(
      otlpSpan({
        traceId,
        spanId: callId,
        parentSpanId: span.parentId ? id(span.parentId) : rootId,
        name: toolSpanName(span),
        start: span.start,
        end: isAgent ? Math.min(end, span.callEnd ?? end) : end,
        attributes: {
          ...shared,
          ...state,
          "sentry.op": sentryOp(span),
          "gen_ai.operation.name": isTool ? "execute_tool" : undefined,
          "gen_ai.tool.name": isTool ? span.toolName : undefined,
          // bb's id for the call; providers' own call ids do not reach bb's events.
          "gen_ai.tool.call.id": isTool ? span.id : undefined,
          // Agent attribution belongs on agent and tool spans, not on waits or markers.
          "gen_ai.agent.name": isTool ? caller : undefined,
          "gen_ai.transfer.target.name": isAgent ? span.agent : undefined,
          "gen_ai.transfer.mode": isAgent ? "return_to_caller" : undefined,
          // Scrubbed where the trace was built, string by string. Scrubbing
          // their JSON again as text would mistake its quotes for a command's.
          "gen_ai.tool.call.arguments":
            captureContent && isTool && span.args ? recap(span.args, MAX_ARGS) : undefined,
          "gen_ai.tool.call.result":
            captureContent && isTool && span.result ? recap(span.result, MAX_RESULT) : undefined,
          "process.exit.code": span.exitCode ?? undefined,
          "bb.span.detail": captureContent && span.detail ? scrub(span.detail, 300) : undefined,
        },
        error,
      }),
    );
    if (!isAgent) continue;
    spans.push(
      otlpSpan({
        traceId,
        // The subagent's own calls point at this id.
        spanId: id(span.id),
        parentSpanId: callId,
        name: `invoke_agent ${span.agent ?? SUBAGENT}`,
        start: span.start,
        end,
        attributes: {
          ...shared,
          ...state,
          "sentry.op": "gen_ai.invoke_agent",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": span.agent ?? SUBAGENT,
          "bb.subagent.tokens": span.tokens ?? undefined,
        },
        error,
      }),
    );
  }
  if (usageSpan) spans.push(usageSpan);
  return spans;
}
