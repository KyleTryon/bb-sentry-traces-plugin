/**
 * Provider traces and workflow runs that outlive one export: remembered when a
 * turn is sent into them, then sent once they have ended. A provider trace is
 * sent from the snapshot its provider last reported.
 */
import { errorMessage } from "../core/text.js";
import {
  MAX_RUN_ENTRIES,
  MAX_SENT_KEYS_BYTES,
  OPEN_RUN_KEEP_MS,
  SENT_RUN_KEEP_MS,
  TRACE_PREFIX,
  WORKFLOW_PREFIX,
} from "./constants.js";
import { placeWorkflow } from "./location.js";
import { resourceOf, stillSending } from "./settings.js";
import { entries, kv, recordFailure, recordSuccess, trim } from "./store.js";
import { type ExportContext, type ExportSettings, type TraceEntry, type TraceRef, type WorkflowEntry } from "./types.js";
import { deletedTraceSpans, keysToSend, providerSpans } from "../integrations/providers/spans.js";
import { type TraceContext } from "../integrations/providers/types.js";
import { type WorkflowContext } from "../integrations/workflows/ids.js";
import { workflowEnded } from "../integrations/workflows/schema.js";
import { deletedWorkflowSpans, workflowSpans } from "../integrations/workflows/spans.js";
import { type SendResult, type SentryTarget, sendSpans } from "../sentry.js";

/** What one entry of a sweep came to: go on to the next, or stop, as a refused key refuses them all. */
type Swept = "next" | "stop";

/**
 * When there are too many runs, those already sent go first, oldest first,
 * then open ones: a burst of short runs cannot push out one still open.
 */
function dropFirst(a: { firstSeenAt: number; sentAt: number | null }, b: typeof a): number {
  if ((a.sentAt === null) !== (b.sentAt === null)) return a.sentAt === null ? 1 : -1;
  return (a.sentAt ?? a.firstSeenAt) - (b.sentAt ?? b.firstSeenAt);
}

/**
 * Runs `one` on every entry under `prefix`. The settings are read again before
 * each, and the sweep stops once they no longer send to `target`. An entry
 * that throws is skipped, so it cannot hold back the others every tick.
 */
async function sweep<T>(
  ctx: ExportContext,
  prefix: string,
  target: SentryTarget,
  one: (id: string, entry: T, settings: ExportSettings) => Promise<Swept>,
): Promise<void> {
  for (const [id, entry] of Object.entries(await entries<T>(ctx, prefix))) {
    const settings = await stillSending(ctx, target);
    if (!settings) return;
    try {
      if ((await one(id, entry, settings)) === "stop") return;
    } catch (cause) {
      ctx.bb.log.warn(`Could not send ${prefix}${id}: ${errorMessage(cause)}`);
    }
  }
}

/**
 * Saves what an entry came to once its spans were sent. When that cannot be
 * saved, the entry is dropped: kept as it was, the same spans would go out
 * again every tick.
 */
async function settle(ctx: ExportContext, key: string, value: TraceEntry | WorkflowEntry): Promise<void> {
  try {
    await kv(ctx).set(key, value);
  } catch (cause) {
    ctx.bb.log.warn(`Could not save ${key}, which is dropped so it is not sent again: ${errorMessage(cause)}`);
    await kv(ctx).delete(key);
  }
}

/** A failed send of a run: whether the sweep goes on. A payload Sentry refused is given up. */
async function failedRun(
  ctx: ExportContext,
  label: string,
  key: string,
  result: SendResult,
  done: TraceEntry | WorkflowEntry,
): Promise<Swept> {
  ctx.bb.log.warn(`Could not send ${label}: ${result.message}`);
  await recordFailure(ctx, result.message);
  // Refused as it is: it would be refused again, so it is given up.
  if (result.payloadRejected) await settle(ctx, key, done);
  // A refused key refuses everything else too: try again next time.
  else if (!result.retryable) return "stop";
  return "next";
}

export function traceEntries(ctx: ExportContext): Promise<Record<string, TraceEntry>> {
  return entries<TraceEntry>(ctx, TRACE_PREFIX);
}

function traceRef(trace: TraceContext): TraceRef {
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
  await trim<TraceEntry>(ctx, TRACE_PREFIX, MAX_RUN_ENTRIES, dropFirst, (entry) =>
    ctx.providers.deleteSnapshot(entry.provider, entry.traceKey),
  );
}

/** Drops a provider trace's entry, and the snapshot it was sent from: neither is needed again. */
async function dropTrace(ctx: ExportContext, key: string, entry: TraceEntry): Promise<void> {
  await kv(ctx).delete(key);
  await ctx.providers.deleteSnapshot(entry.provider, entry.traceKey);
}

/**
 * The keys of `due` that still fit in what storage keeps of the keys sent.
 * The others wait for the trace's end, when the rest goes out anyway.
 */
function fitting(sent: ReadonlySet<string>, due: ReadonlySet<string>): Set<string> {
  const size = (key: string) => Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
  let bytes = [...sent].reduce((total, key) => total + size(key), 0);
  const kept = new Set<string>();
  for (const key of due) {
    bytes += size(key);
    if (bytes > MAX_SENT_KEYS_BYTES) break;
    kept.add(key);
  }
  return kept;
}

/**
 * Sends what is due of every remembered provider trace: while it is open, the
 * spans its provider says are final and were not sent yet; once it has ended,
 * the rest, its root included. A trace still open after `OPEN_RUN_KEEP_MS` is
 * sent as it stands, its root marked `bb.trace.state: "open"`.
 */
export function sweepTraces(ctx: ExportContext, target: SentryTarget): Promise<void> {
  return sweep<TraceEntry>(ctx, TRACE_PREFIX, target, (id, entry, settings) =>
    sweepTrace(ctx, id, entry, settings, target),
  );
}

async function sweepTrace(
  ctx: ExportContext,
  id: string,
  entry: TraceEntry,
  settings: ExportSettings,
  target: SentryTarget,
): Promise<Swept> {
  const key = TRACE_PREFIX + id;
  const now = ctx.now();
  if (entry.sentAt !== null) {
    if (now - entry.sentAt > SENT_RUN_KEEP_MS) await dropTrace(ctx, key, entry);
    return "next";
  }
  const expired = now - entry.firstSeenAt > OPEN_RUN_KEEP_MS;
  const head = await ctx.providers.head(entry.provider, entry.traceKey);
  // Nothing new was reported since the last look: what was due then went out.
  if (head && head.version === entry.seenVersion && !expired) return "next";
  const read = head ? await ctx.providers.read(entry.provider, entry.traceKey, head) : undefined;
  if (read === undefined) {
    // Nothing reported yet: wait, unless it has been open too long to wait for.
    if (expired) await dropTrace(ctx, key, entry);
    return "next";
  }
  const { trace } = read;
  const sent = new Set(entry.sentKeys ?? []);
  const ended = trace === null || trace.ended || expired;
  const due = trace === null ? new Set<string>() : keysToSend(trace, sent, ended);
  const keys = ended ? due : fitting(sent, due);
  const seenVersion = read.head.version;
  // Nothing new is final yet: the rest waits for the end, or a newer report.
  if (!ended && keys.size === 0) {
    await kv(ctx).set(key, { ...entry, seenVersion } satisfies TraceEntry);
    return "next";
  }
  const spans =
    trace === null
      ? deletedTraceSpans(entry, { from: entry.firstSeenAt, to: now })
      : providerSpans(entry, trace, settings.captureContent, {
          only: keys,
          rootAttributes: trace.ended ? {} : { "bb.trace.state": "open" },
        });
  const done: TraceEntry = ended
    ? { ...entry, sentAt: now, sentKeys: null, seenVersion }
    : { ...entry, sentKeys: [...sent, ...keys], seenVersion };
  const result = await sendSpans(target, spans, resourceOf(settings), ctx.fetch);
  if (!result.ok) return failedRun(ctx, `trace ${id}`, key, result, done);
  await settle(ctx, key, done);
  await recordSuccess(ctx, { turns: 0, spans: result.spans, traces: ended ? 1 : 0 });
  return "next";
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
  await trim<WorkflowEntry>(ctx, WORKFLOW_PREFIX, MAX_RUN_ENTRIES, dropFirst);
}

/** Sends the structure of every remembered workflow run that has ended, once. */
export function sweepWorkflows(ctx: ExportContext, target: SentryTarget): Promise<void> {
  return sweep<WorkflowEntry>(ctx, WORKFLOW_PREFIX, target, (runId, entry, settings) =>
    sweepWorkflow(ctx, runId, entry, settings, target),
  );
}

async function sweepWorkflow(
  ctx: ExportContext,
  runId: string,
  entry: WorkflowEntry,
  settings: ExportSettings,
  target: SentryTarget,
): Promise<Swept> {
  const key = WORKFLOW_PREFIX + runId;
  const now = ctx.now();
  if (entry.sentAt !== null || now - entry.firstSeenAt > OPEN_RUN_KEEP_MS) {
    if (entry.sentAt === null || now - entry.sentAt > SENT_RUN_KEEP_MS) await kv(ctx).delete(key);
    return "next";
  }
  const view = await ctx.workflows.runView(entry.originThreadId, runId);
  // No answer: ask again later. Still queued or running: its spans wait.
  if (view === undefined || (view !== null && !workflowEnded(view))) return "next";
  const placement = await placeWorkflow(ctx, runId, entry, view);
  if (!placement) return "next";
  const spans =
    view === null
      ? deletedWorkflowSpans({ runId, originThreadId: entry.originThreadId }, placement, {
          from: entry.firstSeenAt,
          to: now,
        })
      : workflowSpans(view, entry.originThreadId, placement, settings.captureContent, now);
  const done: WorkflowEntry = { ...entry, sentAt: now };
  const result = await sendSpans(target, spans, resourceOf(settings), ctx.fetch);
  if (!result.ok) return failedRun(ctx, `workflow run ${runId}`, key, result, done);
  await settle(ctx, key, done);
  await recordSuccess(ctx, { turns: 0, spans: result.spans, workflows: 1 });
  return "next";
}
