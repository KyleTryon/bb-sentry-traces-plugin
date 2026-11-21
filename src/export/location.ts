/** Where a thread's turns and a workflow run's spans go: a provider trace, a workflow, or their own trace. */
import { WORKFLOW_LINK_WAIT_MS } from "./constants.js";
import { type ExportContext, type WorkflowEntry } from "./types.js";
import { workflowSpan } from "../integrations/providers/placement.js";
import { providerSpanId, providerTraceId, traceAttributes } from "../integrations/providers/spans.js";
import { workflowTraceId } from "../integrations/workflows/ids.js";
import { type WorkflowPlacement, workflowHint } from "../integrations/workflows/placement.js";
import { type WorkflowRunView, allCalls } from "../integrations/workflows/schema.js";
import { type ThreadInfo } from "../thread.js";

/**
 * The workflow call and the provider trace a thread belongs to, if any.
 * `trace` is undefined when a provider that may claim the thread did not answer.
 */
export async function placeThread(ctx: ExportContext, thread: ThreadInfo) {
  const workflow = await ctx.workflows.workerContext(thread);
  const trace = await ctx.providers.threadContext({
    threadId: thread.id,
    workflow:
      workflow && workflow.callId
        ? {
            runId: workflow.runId,
            name: workflow.scriptName ?? null,
            callId: workflow.callId,
            callIndex: workflow.callIndex,
            originThreadId: workflow.originThreadId,
            phase: workflow.call?.phase ?? null,
            provider: workflow.call?.provider ?? null,
            model: workflow.call?.model ?? null,
            reasoningLevel: workflow.call?.reasoningLevel ?? null,
          }
        : null,
  });
  return { workflow, trace };
}

/**
 * Where a workflow run's own spans go, or null to wait: a workflow inside a
 * provider's trace hangs under the span that names it, and the provider may
 * need a moment after the workflow ends to know which span that is.
 */
export async function placeWorkflow(
  ctx: ExportContext,
  runId: string,
  entry: WorkflowEntry,
  view: WorkflowRunView | null,
): Promise<WorkflowPlacement | null> {
  const ref = entry.trace;
  if (!ref) {
    return { traceId: workflowTraceId(runId), parentSpanId: null, attributes: {}, pipeline: true };
  }
  const trace = await ctx.providers.trace(ref.provider, ref.traceKey, false);
  const owner = workflowSpan(trace, { runId, name: view?.name ?? null });
  const finishedAt = view?.finishedAt ?? null;
  const waited = finishedAt === null || ctx.now() - finishedAt >= WORKFLOW_LINK_WAIT_MS;
  // Wait while the provider has not named the run, or has not answered at
  // all: placing it now would be for good. Only "no such trace" is final.
  if (trace !== null && !owner && !waited) return null;

  // The agent each worker ran as, so a call that ran no thread of its own is named too.
  const queries = view
    ? allCalls(view).flatMap((call) => workflowHint(view, call, entry.originThreadId) ?? [])
    : [];
  const agents = await ctx.providers.contexts(ref.provider, queries);
  return {
    traceId: providerTraceId(ref.provider, ref.traceKey),
    parentSpanId: providerSpanId(
      ref.provider,
      ref.traceKey,
      owner?.key ?? ref.fallbackParentKey,
    ),
    attributes: traceAttributes(ref),
    pipeline: !ref.pipeline,
    agents,
  };
}
