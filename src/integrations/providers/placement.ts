/**
 * Where a thread or a workflow run sits in a provider's trace.
 */
import type { ProviderSpan, ProviderTrace } from "./schema.js";
import type { TraceContext } from "./types.js";

/**
 * The context a turn belongs to. A thread stays tied to its trace after the
 * trace has ended (a coordinator thread can be chatted in for days), so a turn
 * that started after the end is the thread's own and gets its own trace.
 */
export function contextForTurn(
  turn: { start: number },
  context: TraceContext | null,
): TraceContext | null {
  if (!context || context.endedAt === null) return context;
  return turn.start >= context.endedAt ? null : context;
}

/** A bb Workflows run, as a provider's span can name it: by run id or by script name. */
export interface WorkflowRef {
  runId: string;
  name: string | null;
}

/** The span of a trace that says it started the workflow run, if any. */
export function workflowSpan(
  trace: ProviderTrace | null | undefined,
  workflow: WorkflowRef,
): ProviderSpan | undefined {
  return trace?.spans.find(
    (span) =>
      span.workflowRunId === workflow.runId ||
      (workflow.name !== null && span.workflowName === workflow.name),
  );
}

