/** Where a thread's turns and a workflow run's spans go: a provider trace, a workflow, or their own trace. */
import { WORKFLOW_LINK_WAIT_MS } from "./constants.js";
import { type ExportContext, type WorkflowEntry } from "./types.js";
import { workflowSpan } from "../integrations/providers/placement.js";
import { providerSpanId, providerTraceId, traceAttributes } from "../integrations/providers/spans.js";
import { type TraceContext } from "../integrations/providers/types.js";
import { NOT_NOW } from "../integrations/workflows/client.js";
import { type WorkflowContext, workflowTraceId } from "../integrations/workflows/ids.js";
import { type WorkflowPlacement } from "../integrations/workflows/placement.js";
import { type WorkflowRunView, allCalls } from "../integrations/workflows/schema.js";
import { type ThreadInfo } from "../thread.js";

/**
 * The provider trace a thread is in: the one a provider claimed it for, else,
 * for a workflow worker, the one the thread that started its workflow is in.
 * A worker placed that way gets the trace but not that thread's agent.
 */
async function claimedTrace(
  ctx: ExportContext,
  threadId: string,
  workflow: WorkflowContext | null,
): Promise<TraceContext | null> {
  const own = await ctx.providers.claim(threadId);
  if (own || !workflow) return own;
  const origin = await ctx.providers.claim(workflow.originThreadId);
  return origin ? { ...origin, agentId: null, agentName: null, model: null, attributes: {} } : null;
}

interface ThreadPlacement {
  workflow: WorkflowContext | null;
  trace: TraceContext | null;
}

/**
 * The workflow call and the provider trace a thread belongs to, if any, or
 * `NOT_NOW` for a worker while Workflows fails for a moment.
 */
export async function placeThread(ctx: ExportContext, thread: ThreadInfo): Promise<ThreadPlacement | typeof NOT_NOW> {
  const workflow = await ctx.workflows.workerContext(thread);
  if (workflow === NOT_NOW) return NOT_NOW;
  return { workflow, trace: await claimedTrace(ctx, thread.id, workflow) };
}

/** Where a thread is placed as things stand, for a preview: a worker Workflows cannot place now shows on its own. */
export async function placeNow(ctx: ExportContext, thread: ThreadInfo): Promise<ThreadPlacement> {
  const placed = await placeThread(ctx, thread);
  return placed === NOT_NOW ? { workflow: null, trace: await claimedTrace(ctx, thread.id, null) } : placed;
}

/** The agent each worker of a run runs as, where the same provider claimed the worker. */
async function workerAgents(ctx: ExportContext, provider: string, view: WorkflowRunView | null) {
  const agents = new Map<string, { agentId: string | null; agentName: string | null }>();
  for (const call of view ? allCalls(view) : []) {
    if (!call.childThreadId) continue;
    const claim = await ctx.providers.claim(call.childThreadId);
    if (claim?.provider === provider) {
      agents.set(call.childThreadId, { agentId: claim.agentId, agentName: claim.agentName });
    }
  }
  return agents;
}

/**
 * Where a workflow run's own spans go, or null to wait: a workflow inside a
 * provider's trace hangs under the span that names it, and the provider may
 * need a moment after the workflow ends to report which span that is.
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
  const trace = await ctx.providers.snapshot(ref.provider, ref.traceKey);
  const owner = workflowSpan(trace, { runId, name: view?.name ?? null });
  const finishedAt = view?.finishedAt ?? null;
  const waited = finishedAt === null || ctx.now() - finishedAt >= WORKFLOW_LINK_WAIT_MS;
  // Wait while the provider has not named the run, or has not reported the
  // trace yet: placing it now would be for good. Only "deleted" is final.
  if (trace !== null && !owner && !waited) return null;
  return {
    traceId: providerTraceId(ref.provider, ref.traceKey),
    parentSpanId: providerSpanId(ref.provider, ref.traceKey, owner?.key ?? ref.fallbackParentKey),
    attributes: traceAttributes(ref),
    pipeline: !ref.pipeline,
    agents: await workerAgents(ctx, ref.provider, view),
  };
}
