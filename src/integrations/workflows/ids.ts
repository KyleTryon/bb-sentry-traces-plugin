/**
 * Ids and attributes that tie a workflow worker's turns to its run. The same
 * ids are derived in any export, so a run is one trace however it is sent.
 */
import { spanIdFor, traceIdFor, type AttributeValue } from "../../core/otlp.js";

/** Where a worker thread sits in a Workflows run. */
export interface WorkflowContext {
  runId: string;
  /** The call the worker serves; null on the run's own spans. */
  callId: string | null;
  /** The thread that started the workflow. */
  originThreadId: string;
  /** The workflow's name, when it is a plain identifier. */
  name: string | null;
  /** The name exactly as the script declares it. Told to trace providers, never sent. */
  scriptName?: string | null;
  callIndex: number | null;
  /** What the worker's call ran with, passed to trace providers so they can name its agent. */
  call?: {
    phase: string | null;
    provider: string | null;
    model: string | null;
    reasoningLevel: string | null;
  } | null;
}

export function workflowTraceId(runId: string): string {
  return traceIdFor(`workflow-run/${runId}`);
}
export function workflowRootSpanId(runId: string): string {
  return spanIdFor(`workflow-run/${runId}/root`);
}
export function workflowPhaseSpanId(runId: string, phaseIndex: number): string {
  return spanIdFor(`workflow-run/${runId}/phase/${phaseIndex}`);
}
export function workflowCallSpanId(runId: string, callId: string): string {
  return spanIdFor(`workflow-run/${runId}/call/${callId}`);
}

/**
 * The attributes every span of a workflow run carries. `pipeline` is off
 * inside a provider's trace that names a pipeline of its own.
 */
export function workflowAttributes(
  workflow: WorkflowContext,
  pipeline: boolean,
): Record<string, AttributeValue> {
  return {
    "bb.workflow.run_id": workflow.runId,
    "bb.workflow.name": workflow.name,
    "bb.workflow.origin_thread_id": workflow.originThreadId,
    "bb.workflow.call_id": workflow.callId,
    "bb.workflow.call.index": workflow.callIndex ?? undefined,
    // Left out entirely when off, so it cannot blank the run's own value.
    ...(pipeline ? { "gen_ai.pipeline.name": workflow.name } : {}),
  };
}
