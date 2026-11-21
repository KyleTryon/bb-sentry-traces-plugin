/**
 * Provider traces and workflow runs that outlive one export: remembered when a
 * turn is sent into them, then sent once they have ended.
 */
import { MAX_RUN_ENTRIES, OPEN_RUN_KEEP_MS, SENT_RUN_KEEP_MS, TRACE_PREFIX, WORKFLOW_PREFIX } from "./constants.js";
import { placeWorkflow } from "./location.js";
import { resourceOf } from "./settings.js";
import { entries, kv, recordFailure, recordSuccess, trim } from "./store.js";
import { type ExportContext, type ExportSettings, type TraceEntry, type TraceRef, type WorkflowEntry } from "./types.js";
import { deletedTraceSpans, keysToSend, providerSpans } from "../integrations/providers/spans.js";
import { type TraceContext } from "../integrations/providers/types.js";
import { type WorkflowContext } from "../integrations/workflows/ids.js";
import { workflowEnded } from "../integrations/workflows/schema.js";
import { deletedWorkflowSpans, workflowSpans } from "../integrations/workflows/spans.js";
import { type SentryTarget, sendSpans } from "../sentry.js";

export function traceEntries(ctx: ExportContext): Promise<Record<string, TraceEntry>> {
  return entries<TraceEntry>(ctx, TRACE_PREFIX);
}

export function traceRef(trace: TraceContext): TraceRef {
  return {
    provider: trace.provider,
    traceKey: trace.traceKey,
    pipeline: trace.pipeline,
    traceAttributes: trace.traceAttributes,
  };
}

/** Remembers a provider trace whose own spans still have to be sent when it ends. */
export async function noteTrace(ctx: ExportContext, trace: TraceContext): Promise<void> {
  const key = `${TRACE_PREFIX}${trace.provider}/${trace.traceKey}`;
  if ((await kv(ctx).get(key)) !== undefined) return;
  await kv(ctx).set(key, { ...traceRef(trace), firstSeenAt: ctx.now(), sentAt: null } satisfies TraceEntry);
  await trim<TraceEntry>(ctx, TRACE_PREFIX, MAX_RUN_ENTRIES, (entry) => entry.firstSeenAt);
}

/**
 * Sends what is due of every remembered provider trace: while it is open, the
 * spans its provider says are final and were not sent yet; once it has ended,
 * the rest, its root included. A trace still open after `OPEN_RUN_KEEP_MS` is
 * sent as it stands, its root marked `bb.trace.state: "open"`.
 */
export async function sweepTraces(
  ctx: ExportContext,
  settings: ExportSettings,
  target: SentryTarget,
): Promise<void> {
  for (const [id, entry] of Object.entries(await traceEntries(ctx))) {
    const key = TRACE_PREFIX + id;
    const now = ctx.now();
    if (entry.sentAt !== null) {
      if (now - entry.sentAt > SENT_RUN_KEEP_MS) await kv(ctx).delete(key);
      continue;
    }
    const expired = now - entry.firstSeenAt > OPEN_RUN_KEEP_MS;
    const trace = await ctx.providers.trace(entry.provider, entry.traceKey, settings.captureContent);
    if (trace === undefined) {
      // No answer: ask again later, unless it has been open too long to wait for.
      if (expired) await kv(ctx).delete(key);
      continue;
    }
    const sent = new Set(entry.sentKeys ?? []);
    const ended = trace === null || trace.ended || expired;
    const keys = trace === null ? new Set<string>() : keysToSend(trace, sent, ended);
    // Nothing new is final yet: the rest waits for the end.
    if (!ended && keys.size === 0) continue;
    const spans =
      trace === null
        ? deletedTraceSpans(entry, { from: entry.firstSeenAt, to: now })
        : providerSpans(entry, trace, settings.captureContent, {
            only: keys,
            rootAttributes: trace.ended ? {} : { "bb.trace.state": "open" },
          });
    const done: TraceEntry = ended
      ? { ...entry, sentAt: now, sentKeys: null }
      : { ...entry, sentKeys: [...sent, ...keys] };
    const result = await sendSpans(target, spans, resourceOf(settings), ctx.fetch);
    if (!result.ok) {
      ctx.bb.log.warn(`Could not send trace ${id}: ${result.message}`);
      await recordFailure(ctx, result.message);
      // Refused as it is: it would be refused again, so it is given up.
      if (result.payloadRejected) await kv(ctx).set(key, done);
      // A refused key refuses everything else too: try again next time.
      else if (!result.retryable) return;
      continue;
    }
    await kv(ctx).set(key, done);
    await recordSuccess(ctx, { turns: 0, spans: result.spans, traces: ended ? 1 : 0 });
  }
}

export function workflowEntries(ctx: ExportContext): Promise<Record<string, WorkflowEntry>> {
  return entries<WorkflowEntry>(ctx, WORKFLOW_PREFIX);
}

/** Remembers a workflow run whose own spans still have to be sent when it ends. */
export async function noteWorkflow(
  ctx: ExportContext,
  workflow: WorkflowContext,
  trace: TraceContext | null,
): Promise<void> {
  const key = WORKFLOW_PREFIX + workflow.runId;
  if ((await kv(ctx).get(key)) !== undefined) return;
  await kv(ctx).set(key, {
    originThreadId: workflow.originThreadId,
    firstSeenAt: ctx.now(),
    sentAt: null,
    trace: trace ? { ...traceRef(trace), fallbackParentKey: trace.parentKey } : null,
  } satisfies WorkflowEntry);
  await trim<WorkflowEntry>(ctx, WORKFLOW_PREFIX, MAX_RUN_ENTRIES, (entry) => entry.firstSeenAt);
}

/** Sends the structure of every remembered workflow run that has ended, once. */
export async function sweepWorkflows(
  ctx: ExportContext,
  settings: ExportSettings,
  target: SentryTarget,
): Promise<void> {
  for (const [runId, entry] of Object.entries(await workflowEntries(ctx))) {
    const key = WORKFLOW_PREFIX + runId;
    const now = ctx.now();
    if (entry.sentAt !== null || now - entry.firstSeenAt > OPEN_RUN_KEEP_MS) {
      if (entry.sentAt === null || now - entry.sentAt > SENT_RUN_KEEP_MS) await kv(ctx).delete(key);
      continue;
    }
    const view = await ctx.workflows.runView(entry.originThreadId, runId);
    // No answer: ask again later. Still queued or running: its spans wait.
    if (view === undefined || (view !== null && !workflowEnded(view))) continue;
    const placement = await placeWorkflow(ctx, runId, entry, view);
    if (!placement) continue;
    const spans =
      view === null
        ? deletedWorkflowSpans({ runId, originThreadId: entry.originThreadId }, placement, {
            from: entry.firstSeenAt,
            to: now,
          })
        : workflowSpans(view, entry.originThreadId, placement, settings.captureContent, now);
    const result = await sendSpans(target, spans, resourceOf(settings), ctx.fetch);
    if (!result.ok) {
      ctx.bb.log.warn(`Could not send workflow run ${runId}: ${result.message}`);
      await recordFailure(ctx, result.message);
      if (result.payloadRejected) await kv(ctx).set(key, { ...entry, sentAt: now } satisfies WorkflowEntry);
      else if (!result.retryable) return;
      continue;
    }
    await kv(ctx).set(key, { ...entry, sentAt: now } satisfies WorkflowEntry);
    await recordSuccess(ctx, { turns: 0, spans: result.spans, workflows: 1 });
  }
}
