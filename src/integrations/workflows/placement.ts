/**
 * Where a workflow call's worker threads and the run's spans go: the hint a
 * trace provider gets for each worker, and the trace and parent a run's spans
 * are placed under.
 */
import type { AttributeValue } from "../../core/otlp.js";
import type { WorkflowHint } from "../providers/types.js";
import { callFacts, type WorkflowCall, type WorkflowRunView } from "./schema.js";

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
