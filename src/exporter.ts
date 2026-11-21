/**
 * The export loop: when a thread goes idle or fails, send the turns that
 * finished since the last export, once each.
 *
 * What was sent lives in plugin storage, so a restart cannot send a turn twice
 * or fork a trace. Nothing is cached between exports: each one folds the
 * thread's events from where the last stopped and then lets the result go.
 * Exports of one thread run one at a time, and nothing here throws into bb.
 *
 * Exports of different threads and the periodic sweep run side by side, so
 * every retry, provider trace and workflow run is stored under a key of its
 * own, and the one shared record, the stats, is only changed under a lock.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { AttributeValue, OtlpSpan, ResourceInfo } from "./otlp.js";
import {
  contextForTurn,
  deletedTraceSpans,
  providerSpanId,
  providerSpans,
  providerTraceId,
  traceAttributes,
  TraceProviders,
  workflowSpan,
  type TraceContext,
} from "./providers.js";
import { parseDsn, sendSpans, type Fetch, type SendResult, type SentryTarget } from "./sentry.js";
import { turnSpans, workflowTraceId, type TurnUsage, type WorkflowContext } from "./spans.js";
import { TRACE_EVENT_TYPES, TraceBuilder, type TraceEvent, type Turn } from "./trace.js";
import { isEmptyUsage, readTotal, toSentryUsage, usageDelta, type RawUsage } from "./usage.js";
import { errorMessage, toThreadInfo, type ThreadInfo } from "./util.js";
import { VERSION } from "./version.js";
import {
  allCalls,
  deletedWorkflowSpans,
  workflowEnded,
  workflowHint,
  WorkflowsClient,
  workflowSpans,
  type WorkflowPlacement,
  type WorkflowRunView,
} from "./workflows.js";

export interface ExportSettings {
  dsn: string | undefined;
  enabled: boolean;
  captureContent: boolean;
  environment: string;
  /** Plugin ids to ask which trace a thread belongs to. */
  providers: string[];
}

/** What is remembered about a thread between exports. */
export interface ThreadState {
  /** The index of the last turn sent, or null when none has been. */
  sentTurn: number | null;
  /** Events at or below this sequence never need reading again. */
  resumeSeq: number;
  /** How many top-level turns started at or before `resumeSeq`. */
  turnsBefore: number;
  /** The thread's running token total when it was last looked at. */
  usage: RawUsage | null;
  /** Whether `usage` was actually read, so a null means "none yet", not "unknown". */
  usageKnown: boolean;
  /**
   * A turn whose spans went out in several requests and stopped part way:
   * the ids of the spans Sentry already has, so they are not sent twice.
   */
  partial?: { turnId: string; spanIds: string[] } | null;
  updatedAt: number;
}

export interface Stats {
  turnsSent: number;
  spansSent: number;
  /** Provider traces whose own spans were sent. */
  tracesSent: number;
  workflowsSent: number;
  failures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

interface RetryEntry {
  attempts: number;
  nextAt: number;
}
/** The part of a provider trace that outlives one export. */
interface TraceRef {
  provider: string;
  traceKey: string;
  pipeline: string | null;
  traceAttributes: Record<string, AttributeValue>;
}

/** A provider trace whose own spans still have to be sent when it ends. */
interface TraceEntry extends TraceRef {
  firstSeenAt: number;
  sentAt: number | null;
}

/** A workflow run whose own spans still have to be sent when it ends. */
interface WorkflowEntry {
  originThreadId: string;
  firstSeenAt: number;
  sentAt: number | null;
  /**
   * The provider trace the workflow belongs to, when it belongs to one, and
   * the span it hangs under when no span of that trace names it.
   */
  trace: (TraceRef & { fallbackParentKey: string }) | null;
}

export type ExportOutcome =
  | { kind: "disabled" | "not-configured" | "nothing" }
  | { kind: "sent"; turns: number; spans: number; traceIds: string[] }
  | { kind: "failed"; message: string; retryable: boolean };

const THREAD_KEY = "thread:";
/** One key per entry, so concurrent writers never overwrite each other's entries. */
const RETRY_PREFIX = "retry:";
const TRACE_PREFIX = "trace:";
const WORKFLOW_PREFIX = "workflow:";
const STATS_KEY = "stats";
/** Where 0.1.0 kept the same entries as one map per kind; moved over once. */
const LEGACY_KEYS = { retry: RETRY_PREFIX, traces: TRACE_PREFIX, workflows: WORKFLOW_PREFIX } as const;

const PAGE_SIZE = 100;
/** One read covers at most this many pages of matching events. */
const MAX_PAGES = 400;
/**
 * A thread never sent before starts with its newest turn. When its history is
 * longer than one read, an export reads on through at most this many more
 * before it leaves the rest to the next export.
 */
const MAX_CATCH_UP_READS = 4;
/** Ids kept for a turn cut short; past this, a few of its spans may be sent twice. */
const MAX_PARTIAL_IDS = 4_000;
/** After a long gap, only the newest turns are sent. */
const MAX_TURNS_PER_EXPORT = 25;
const MAX_RETRY_ATTEMPTS = 8;
const MAX_RETRY_ENTRIES = 200;
const MAX_RUN_ENTRIES = 200;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** An unanswered prompt older than this no longer holds the read position back. */
const REQUEST_WINDOW_MS = 24 * 60 * 60_000;
const SENT_RUN_KEEP_MS = 24 * 60 * 60_000;
const OPEN_RUN_KEEP_MS = 30 * 24 * 60 * 60_000;
/**
 * How long a finished workflow waits for a span of its provider's trace to
 * name it. A provider may only learn that when it handles the workflow's result.
 */
const WORKFLOW_LINK_WAIT_MS = 10 * 60_000;

const EVENT_TYPES = [...TRACE_EVENT_TYPES] as unknown as Parameters<
  BbPluginApi["sdk"]["threads"]["events"]["list"]
>[0]["types"];

export interface ExporterDeps {
  bb: Pick<BbPluginApi, "sdk" | "log" | "storage">;
  settings: () => Promise<ExportSettings>;
  fetch?: Fetch;
  now?: () => number;
}

/** A thread's turns and what the next export needs to know to continue from here. */
interface Folded {
  turns: Turn[];
  builder: TraceBuilder;
  truncated: boolean;
}

export function emptyStats(): Stats {
  return {
    turnsSent: 0,
    spansSent: 0,
    tracesSent: 0,
    workflowsSent: 0,
    failures: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
  };
}

export class Exporter {
  readonly providers: TraceProviders;
  readonly workflows: WorkflowsClient;
  private readonly bb: ExporterDeps["bb"];
  private readonly settings: ExporterDeps["settings"];
  private readonly fetchImpl: Fetch | undefined;
  private readonly now: () => number;
  /** One export at a time per thread, so back-to-back events never send a turn twice. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** Read-modify-write of a shared storage key, one at a time. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private migrated = false;
  private disposed = false;

  constructor(deps: ExporterDeps) {
    this.bb = deps.bb;
    this.settings = deps.settings;
    this.fetchImpl = deps.fetch;
    this.now = deps.now ?? Date.now;
    this.providers = new TraceProviders(
      deps.bb,
      async () => (await this.settings()).providers,
      this.now,
    );
    this.workflows = new WorkflowsClient(deps.bb, this.now);
  }

  dispose(): void {
    this.disposed = true;
  }

  private get kv() {
    return this.bb.storage.kv;
  }

  private resource(settings: ExportSettings): ResourceInfo {
    return { pluginVersion: VERSION, environment: settings.environment.trim() || null };
  }

  /** The Sentry target, or why there is none. Never includes the key in a message. */
  private target(settings: ExportSettings): { target: SentryTarget } | { reason: string } {
    const parsed = parseDsn(settings.dsn);
    return parsed.ok ? { target: parsed.target } : { reason: parsed.reason };
  }

  // ------------------------------------------------------------ event handlers

  /** Runs `work` after everything already queued for the thread. Never rejects. */
  private serialize<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    return queue(this.chains, threadId, work);
  }

  /** Changes a shared storage record in place; `change` returns false to leave it as it was. */
  private mutate<T>(key: string, empty: () => T, change: (value: T) => boolean | void): Promise<void> {
    return queue(this.locks, key, async () => {
      const value = (await this.kv.get<T>(key)) ?? empty();
      if (change(value) !== false) await this.kv.set(key, value);
    });
  }

  /** Queues an export of the thread. Safe to call from an event handler. */
  enqueue(thread: ThreadInfo): Promise<ExportOutcome> {
    return this.serialize(thread.id, async (): Promise<ExportOutcome> => {
      if (this.disposed) return { kind: "nothing" };
      try {
        return await this.exportThread(thread);
      } catch (cause) {
        const message = errorMessage(cause);
        this.bb.log.warn(`Could not export thread ${thread.id}: ${message}`);
        await this.recordFailure(message).catch(() => undefined);
        await this.scheduleRetry(thread.id).catch(() => undefined);
        return { kind: "failed", message, retryable: true };
      }
    });
  }

  /**
   * Remembers a thread's token total when a turn starts on a thread that has
   * never been exported, so the first exported turn is not charged with the
   * whole thread's history.
   */
  noteActive(threadId: string): Promise<void> {
    return this.serialize(threadId, async () => {
      if (this.disposed) return;
      try {
        const settings = await this.settings();
        if (!settings.enabled || "reason" in this.target(settings)) return;
        if (await this.kv.get<ThreadState>(THREAD_KEY + threadId)) return;
        await this.kv.set(THREAD_KEY + threadId, {
          sentTurn: null,
          resumeSeq: 0,
          turnsBefore: 0,
          usage: await this.readUsage(threadId),
          usageKnown: true,
          updatedAt: this.now(),
        } satisfies ThreadState);
      } catch (cause) {
        this.bb.log.debug(`Could not note the start of ${threadId}: ${errorMessage(cause)}`);
      }
    });
  }

  /** Drops what is kept about a deleted thread, after any export of it still running. */
  forget(threadId: string): Promise<void> {
    return this.serialize(threadId, async () => {
      try {
        await this.kv.delete(THREAD_KEY + threadId);
        await this.kv.delete(RETRY_PREFIX + threadId);
      } catch (cause) {
        this.bb.log.debug(`Could not forget ${threadId}: ${errorMessage(cause)}`);
      }
    });
  }

  // ------------------------------------------------------------------- reading

  private async readEvents(threadId: string, afterSeq: number, builder: TraceBuilder) {
    let cursor = afterSeq;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = await this.bb.sdk.threads.events.list({
        threadId,
        afterSeq: String(cursor),
        limit: String(PAGE_SIZE),
        types: EVENT_TYPES,
      });
      if (rows.length === 0) return false;
      builder.apply(rows as unknown as TraceEvent[]);
      cursor = rows[rows.length - 1].seq;
      if (rows.length < PAGE_SIZE) return false;
    }
    return true;
  }

  private async fold(threadId: string, state: ThreadState | undefined, content: boolean) {
    const builder = new TraceBuilder({ content, indexOffset: state?.turnsBefore ?? 0 });
    const truncated = await this.readEvents(threadId, state?.resumeSeq ?? 0, builder);
    return { turns: builder.snapshot(this.now()), builder, truncated } satisfies Folded;
  }

  /** bb keeps only the latest usage event per thread: a running total. */
  private async readUsage(threadId: string): Promise<RawUsage | null> {
    const rows = await this.bb.sdk.threads.events.list({
      threadId,
      order: "desc",
      limit: "1",
      types: ["thread/tokenUsage/updated"],
    });
    return rows.length > 0 ? readTotal(rows[0].data) : null;
  }

  /** Where the next export can start reading without losing a turn's prompt or start. */
  private resumePoint(folded: Folded, state: ThreadState | undefined, sentTurn: number | null) {
    const previous = state?.resumeSeq ?? 0;
    const candidates = [Math.max(previous, folded.builder.lastSeq)];
    for (const turn of folded.turns) {
      if (turn.end !== null && sentTurn !== null && turn.index <= sentTurn) continue;
      candidates.push(Math.min(turn.firstSeq, turn.requestSeq ?? turn.firstSeq) - 1);
    }
    const unanswered = folded.builder.earliestUnmatchedRequest(this.now() - REQUEST_WINDOW_MS);
    if (unanswered !== null) candidates.push(unanswered - 1);
    const resumeSeq = Math.max(previous, Math.min(...candidates));
    const turnsBefore =
      (state?.turnsBefore ?? 0) + folded.turns.filter((turn) => turn.firstSeq <= resumeSeq).length;
    return { resumeSeq, turnsBefore };
  }

  // ----------------------------------------------------------------- exporting

  /** The workflow call and the provider trace a thread belongs to, if any. */
  private async placement(thread: ThreadInfo) {
    const workflow = await this.workflows.workerContext(thread);
    const trace = await this.providers.threadContext({
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
   * The spans for a thread's turns, without sending anything or changing what
   * is remembered. `turns` picks how many of the newest turns; `includeRunning`
   * also takes the turn in progress, ended at the current time.
   *
   * A turn's token usage is only known when it is exported, so it is left out,
   * except when every turn of the thread is picked: then the thread's whole
   * total goes on the last one.
   */
  async preview(
    thread: ThreadInfo,
    options: { captureContent: boolean; turns: number | "all"; includeRunning?: boolean },
  ): Promise<{
    spans: OtlpSpan[];
    turns: number;
    trace: TraceContext | null;
    workflow: WorkflowContext | null;
  }> {
    const folded = await this.fold(thread.id, undefined, options.captureContent);
    const eligible = options.includeRunning
      ? folded.turns
      : folded.turns.filter((turn) => turn.end !== null);
    const picked = options.turns === "all" ? eligible : eligible.slice(-options.turns);
    const usage = new Map<string, TurnUsage>();
    if (picked.length > 0 && picked.length === folded.turns.length) {
      const total = await this.readUsage(thread.id);
      if (total && !isEmptyUsage(total)) {
        usage.set(picked[picked.length - 1].id, {
          usage: toSentryUsage(total),
          turns: picked.length,
        });
      }
    }
    const { workflow, trace } = await this.placement(thread);
    const now = this.now();
    const spans = picked.flatMap((turn) =>
      turnSpans(turn, {
        thread,
        trace: contextForTurn(turn, trace),
        workflow,
        captureContent: options.captureContent,
        now,
        usage,
      }),
    );
    return { spans, turns: picked.length, trace, workflow };
  }

  private async exportThread(thread: ThreadInfo): Promise<ExportOutcome> {
    const settings = await this.settings();
    if (!settings.enabled) return { kind: "disabled" };
    const resolved = this.target(settings);
    if ("reason" in resolved) return { kind: "not-configured" };

    const key = THREAD_KEY + thread.id;
    let state = await this.kv.get<ThreadState>(key);
    let folded = await this.fold(thread.id, state, settings.captureContent);
    // Turning the plugin on sends what finishes from now on, not the whole
    // history: a thread never sent before reads on to its newest turns.
    for (let reads = 0; folded.truncated && (state?.sentTurn ?? null) === null; reads++) {
      const skipped = folded.turns.filter((turn) => turn.end !== null).at(-1)?.index ?? null;
      const next: ThreadState = {
        sentTurn: null,
        ...this.resumePoint(folded, state, skipped),
        usage: state?.usage ?? null,
        usageKnown: state?.usageKnown ?? false,
        partial: null,
        updatedAt: this.now(),
      };
      // Held back by a turn or prompt it cannot read past: export from what was read.
      if (next.resumeSeq <= (state?.resumeSeq ?? 0)) break;
      await this.kv.set(key, next);
      state = next;
      if (reads >= MAX_CATCH_UP_READS) {
        this.bb.log.debug(`Thread ${thread.id} has a long history; the next export reads on.`);
        return { kind: "nothing" };
      }
      folded = await this.fold(thread.id, state, settings.captureContent);
    }
    if (folded.truncated) {
      this.bb.log.warn(`Thread ${thread.id} has more events than one export reads; its newest turns may wait.`);
    }
    const finished = folded.turns.filter((turn) => turn.end !== null);
    const sentTurn = state?.sentTurn ?? null;
    const pending = (
      sentTurn !== null ? finished.filter((turn) => turn.index > sentTurn) : finished.slice(-1)
    ).slice(-MAX_TURNS_PER_EXPORT);

    if (pending.length === 0) {
      if (state) {
        await this.kv.set(key, {
          ...state,
          ...this.resumePoint(folded, state, sentTurn),
          updatedAt: this.now(),
        } satisfies ThreadState);
      }
      // A retry that finds nothing left to send is done.
      await this.clearRetry(thread.id);
      return { kind: "nothing" };
    }

    const current = await this.readUsage(thread.id);
    const usage = new Map<string, TurnUsage>();
    // Without a known starting total, the total is this turn's only when the
    // thread has no other turns.
    const wholeThread =
      !state && folded.turns.length === pending.length && (folded.turns[0]?.index ?? 1) === 1;
    if (current && (state?.usageKnown || wholeThread)) {
      const delta = usageDelta(current, state?.usage ?? null);
      if (delta && !isEmptyUsage(delta)) {
        // One span of one turn carries it, so cost is never counted twice.
        usage.set(pending[pending.length - 1].id, {
          usage: toSentryUsage(delta),
          turns: pending.length,
        });
      }
    }

    const { workflow, trace } = await this.placement(thread);
    const now = this.now();
    const resource = this.resource(settings);
    // Turns that started after the trace ended are the thread's own.
    const inTrace = pending.some((turn) => contextForTurn(turn, trace) !== null);

    // One turn at a time, so a failure leaves the turns before it sent and the
    // spans Sentry already took are never sent again.
    const partial = state?.partial ?? null;
    let lastDone = sentTurn;
    let cut: { turnId: string; spanIds: string[] } | null = null;
    let failure: SendResult | null = null;
    let refused: SendResult | null = null;
    let usageSent = false;
    let turnsSent = 0;
    let spansSent = 0;
    const traceIds = new Set<string>();
    for (const turn of pending) {
      const all = turnSpans(turn, {
        thread,
        trace: contextForTurn(turn, trace),
        workflow,
        captureContent: settings.captureContent,
        now,
        usage,
      });
      const already = partial?.turnId === turn.id ? new Set(partial.spanIds) : null;
      const spans = already ? all.filter((span) => !already.has(span.spanId)) : all;
      const result = await sendSpans(resolved.target, spans, resource, this.fetchImpl);
      const accepted = spans.slice(0, result.spans);
      spansSent += accepted.length;
      for (const span of accepted) traceIds.add(span.traceId);
      if (result.ok) {
        lastDone = turn.index;
        turnsSent++;
        if (usage.has(turn.id)) usageSent = true;
        continue;
      }
      if (result.payloadRejected) {
        // Sentry would refuse these spans again: give the turn up so the turns after it still go.
        this.bb.log.warn(`Sentry refused turn ${turn.index} of ${thread.id}, which is skipped: ${result.message}`);
        await this.recordFailure(result.message);
        refused = result;
        lastDone = turn.index;
        continue;
      }
      failure = result;
      cut = {
        turnId: turn.id,
        spanIds: [...(already ?? []), ...accepted.map((span) => span.spanId)].slice(0, MAX_PARTIAL_IDS),
      };
      break;
    }

    // The usage span goes last, so a turn that was cut short or refused never
    // sent it: the next export counts it again from the same starting total.
    const usageWaits = usage.size > 0 && !usageSent;
    await this.kv.set(key, {
      sentTurn: lastDone,
      ...this.resumePoint(folded, state, lastDone),
      usage: usageWaits ? (state?.usage ?? null) : (current ?? state?.usage ?? null),
      usageKnown: true,
      partial: cut && cut.spanIds.length > 0 ? cut : null,
      updatedAt: now,
    } satisfies ThreadState);
    if (spansSent > 0) {
      await this.recordSuccess({ turns: turnsSent, spans: spansSent });
      if (trace && inTrace) await this.noteTrace(trace);
      if (workflow) await this.noteWorkflow(workflow, inTrace ? trace : null);
    }
    if (failure) return this.failed(thread.id, failure);
    await this.clearRetry(thread.id);
    if (turnsSent === 0 && refused) {
      return { kind: "failed", message: refused.message, retryable: false };
    }
    return { kind: "sent", turns: turnsSent, spans: spansSent, traceIds: [...traceIds] };
  }

  private async failed(threadId: string, result: SendResult): Promise<ExportOutcome> {
    this.bb.log.warn(`Could not send the trace of ${threadId}: ${result.message}`);
    await this.recordFailure(result.message);
    // A rejected key fails the same way again; the next turn tries anyway.
    if (result.retryable) await this.scheduleRetry(threadId);
    else await this.clearRetry(threadId);
    return { kind: "failed", message: result.message, retryable: result.retryable };
  }

  // ------------------------------------------------------------------- storage

  /** Every entry stored under `prefix`, by the rest of its key. */
  private async entries<T>(prefix: string): Promise<Record<string, T>> {
    const found: Record<string, T> = {};
    for (const key of await this.kv.list(prefix)) {
      const value = await this.kv.get<T>(key);
      if (value !== undefined) found[key.slice(prefix.length)] = value;
    }
    return found;
  }

  /** Keeps at most `max` entries under `prefix`, dropping those that sort first by `age`. */
  private async trim<T>(prefix: string, max: number, age: (entry: T) => number): Promise<void> {
    const keys = await this.kv.list(prefix);
    if (keys.length <= max) return;
    const all = Object.entries(await this.entries<T>(prefix)).sort(([, a], [, b]) => age(a) - age(b));
    for (const [id] of all.slice(0, Math.max(0, all.length - max))) await this.kv.delete(prefix + id);
  }

  /** Moves 0.1.0's one-map-per-kind records to one key per entry. */
  private async migrate(): Promise<void> {
    if (this.migrated) return;
    for (const [legacy, prefix] of Object.entries(LEGACY_KEYS)) {
      const map = await this.kv.get<Record<string, unknown>>(legacy);
      if (map === undefined) continue;
      for (const [id, entry] of Object.entries(map ?? {})) {
        if ((await this.kv.get(prefix + id)) === undefined) await this.kv.set(prefix + id, entry);
      }
      await this.kv.delete(legacy);
    }
    this.migrated = true;
  }

  // ------------------------------------------------------------------- retries

  private retries(): Promise<Record<string, RetryEntry>> {
    return this.entries<RetryEntry>(RETRY_PREFIX);
  }

  private async scheduleRetry(threadId: string): Promise<void> {
    const key = RETRY_PREFIX + threadId;
    const attempts = ((await this.kv.get<RetryEntry>(key))?.attempts ?? 0) + 1;
    if (attempts > MAX_RETRY_ATTEMPTS) {
      await this.kv.delete(key);
      this.bb.log.warn(`Gave up retrying the trace of ${threadId}; its next turn will try again.`);
      return;
    }
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
    await this.kv.set(key, { attempts, nextAt: this.now() + delay } satisfies RetryEntry);
    // The entries due soonest go first when the queue is full.
    await this.trim<RetryEntry>(RETRY_PREFIX, MAX_RETRY_ENTRIES, (entry) => entry.nextAt);
  }

  private async clearRetry(threadId: string): Promise<void> {
    await this.kv.delete(RETRY_PREFIX + threadId);
  }

  // -------------------------------------------------------------------- traces

  private traceEntries(): Promise<Record<string, TraceEntry>> {
    return this.entries<TraceEntry>(TRACE_PREFIX);
  }

  private traceRef(trace: TraceContext): TraceRef {
    return {
      provider: trace.provider,
      traceKey: trace.traceKey,
      pipeline: trace.pipeline,
      traceAttributes: trace.traceAttributes,
    };
  }

  /** Remembers a provider trace whose own spans still have to be sent when it ends. */
  private async noteTrace(trace: TraceContext): Promise<void> {
    const key = `${TRACE_PREFIX}${trace.provider}/${trace.traceKey}`;
    if ((await this.kv.get(key)) !== undefined) return;
    await this.kv.set(key, { ...this.traceRef(trace), firstSeenAt: this.now(), sentAt: null } satisfies TraceEntry);
    await this.trim<TraceEntry>(TRACE_PREFIX, MAX_RUN_ENTRIES, (entry) => entry.firstSeenAt);
  }

  /** Sends the root and structure of every remembered provider trace that has ended, once. */
  private async sweepTraces(settings: ExportSettings, target: SentryTarget): Promise<void> {
    for (const [id, entry] of Object.entries(await this.traceEntries())) {
      const key = TRACE_PREFIX + id;
      const now = this.now();
      if (entry.sentAt !== null || now - entry.firstSeenAt > OPEN_RUN_KEEP_MS) {
        if (entry.sentAt === null || now - entry.sentAt > SENT_RUN_KEEP_MS) await this.kv.delete(key);
        continue;
      }
      const trace = await this.providers.trace(entry.provider, entry.traceKey, settings.captureContent);
      // No answer: ask again later. Not ended: its root waits.
      if (trace === undefined || (trace !== null && !trace.ended)) continue;
      const spans =
        trace === null
          ? deletedTraceSpans(entry, { from: entry.firstSeenAt, to: now })
          : providerSpans(entry, trace, settings.captureContent);
      const result = await sendSpans(target, spans, this.resource(settings), this.fetchImpl);
      if (!result.ok) {
        this.bb.log.warn(`Could not send trace ${id}: ${result.message}`);
        await this.recordFailure(result.message);
        // Refused as it is: it would be refused again, so it is given up.
        if (result.payloadRejected) await this.kv.set(key, { ...entry, sentAt: now } satisfies TraceEntry);
        // A refused key refuses everything else too: try again next time.
        else if (!result.retryable) return;
        continue;
      }
      await this.kv.set(key, { ...entry, sentAt: now } satisfies TraceEntry);
      await this.recordSuccess({ turns: 0, spans: result.spans, traces: 1 });
    }
  }

  // ----------------------------------------------------------------- workflows

  private workflowEntries(): Promise<Record<string, WorkflowEntry>> {
    return this.entries<WorkflowEntry>(WORKFLOW_PREFIX);
  }

  /** Remembers a workflow run whose own spans still have to be sent when it ends. */
  private async noteWorkflow(workflow: WorkflowContext, trace: TraceContext | null): Promise<void> {
    const key = WORKFLOW_PREFIX + workflow.runId;
    if ((await this.kv.get(key)) !== undefined) return;
    await this.kv.set(key, {
      originThreadId: workflow.originThreadId,
      firstSeenAt: this.now(),
      sentAt: null,
      trace: trace ? { ...this.traceRef(trace), fallbackParentKey: trace.parentKey } : null,
    } satisfies WorkflowEntry);
    await this.trim<WorkflowEntry>(WORKFLOW_PREFIX, MAX_RUN_ENTRIES, (entry) => entry.firstSeenAt);
  }

  /**
   * Where a workflow run's own spans go, or null to wait: a workflow inside a
   * provider's trace hangs under the span that names it, and the provider may
   * need a moment after the workflow ends to know which span that is.
   */
  private async workflowPlacement(
    runId: string,
    entry: WorkflowEntry,
    view: WorkflowRunView | null,
  ): Promise<WorkflowPlacement | null> {
    const ref = entry.trace;
    if (!ref) {
      return { traceId: workflowTraceId(runId), parentSpanId: null, attributes: {}, pipeline: true };
    }
    const trace = await this.providers.trace(ref.provider, ref.traceKey, false);
    const owner = workflowSpan(trace, { runId, name: view?.name ?? null });
    const finishedAt = view?.finishedAt ?? null;
    const waited = finishedAt === null || this.now() - finishedAt >= WORKFLOW_LINK_WAIT_MS;
    // Wait while the provider has not named the run, or has not answered at
    // all: placing it now would be for good. Only "no such trace" is final.
    if (trace !== null && !owner && !waited) return null;

    // The agent each worker ran as, so a call that ran no thread of its own is named too.
    const queries = view
      ? allCalls(view).flatMap((call) => workflowHint(view, call, entry.originThreadId) ?? [])
      : [];
    const agents = await this.providers.contexts(ref.provider, queries);
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

  /** Sends the structure of every remembered workflow run that has ended, once. */
  private async sweepWorkflows(settings: ExportSettings, target: SentryTarget): Promise<void> {
    for (const [runId, entry] of Object.entries(await this.workflowEntries())) {
      const key = WORKFLOW_PREFIX + runId;
      const now = this.now();
      if (entry.sentAt !== null || now - entry.firstSeenAt > OPEN_RUN_KEEP_MS) {
        if (entry.sentAt === null || now - entry.sentAt > SENT_RUN_KEEP_MS) await this.kv.delete(key);
        continue;
      }
      const view = await this.workflows.runView(entry.originThreadId, runId);
      // No answer: ask again later. Still queued or running: its spans wait.
      if (view === undefined || (view !== null && !workflowEnded(view))) continue;
      const placement = await this.workflowPlacement(runId, entry, view);
      if (!placement) continue;
      const spans =
        view === null
          ? deletedWorkflowSpans({ runId, originThreadId: entry.originThreadId }, placement, {
              from: entry.firstSeenAt,
              to: now,
            })
          : workflowSpans(view, entry.originThreadId, placement, settings.captureContent, now);
      const result = await sendSpans(target, spans, this.resource(settings), this.fetchImpl);
      if (!result.ok) {
        this.bb.log.warn(`Could not send workflow run ${runId}: ${result.message}`);
        await this.recordFailure(result.message);
        if (result.payloadRejected) await this.kv.set(key, { ...entry, sentAt: now } satisfies WorkflowEntry);
        else if (!result.retryable) return;
        continue;
      }
      await this.kv.set(key, { ...entry, sentAt: now } satisfies WorkflowEntry);
      await this.recordSuccess({ turns: 0, spans: result.spans, workflows: 1 });
    }
  }

  // ---------------------------------------------------------------------- tick

  /** Periodic work: retry failed exports that are due, and send runs that ended. */
  async tick(): Promise<void> {
    if (this.disposed) return;
    try {
      const settings = await this.settings();
      if (!settings.enabled) return;
      const resolved = this.target(settings);
      if ("reason" in resolved) return;
      await this.migrate();

      const retries = await this.retries();
      const now = this.now();
      for (const [threadId, entry] of Object.entries(retries)) {
        if (entry.nextAt > now || this.disposed) continue;
        const thread = await this.threadInfo(threadId);
        if (!thread) {
          await this.clearRetry(threadId);
          continue;
        }
        await this.enqueue(thread);
      }
      await this.sweepTraces(settings, resolved.target);
      await this.sweepWorkflows(settings, resolved.target);
    } catch (cause) {
      this.bb.log.warn(`Periodic export work failed: ${errorMessage(cause)}`);
    }
  }

  async threadInfo(threadId: string): Promise<ThreadInfo | null> {
    try {
      return toThreadInfo(await this.bb.sdk.threads.get({ threadId }));
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------- stats

  async stats(): Promise<Stats> {
    return { ...emptyStats(), ...((await this.kv.get<Stats>(STATS_KEY)) ?? {}) };
  }

  async queueSizes(): Promise<{ retries: number; openTraces: number; openWorkflows: number }> {
    const open = (entries: Record<string, { sentAt: number | null }>) =>
      Object.values(entries).filter((entry) => entry.sentAt === null).length;
    return {
      retries: Object.keys(await this.retries()).length,
      openTraces: open(await this.traceEntries()),
      openWorkflows: open(await this.workflowEntries()),
    };
  }

  async recordSuccess(sent: {
    turns: number;
    spans: number;
    traces?: number;
    workflows?: number;
  }): Promise<void> {
    await this.mutate<Stats>(STATS_KEY, emptyStats, (stats) => {
      stats.turnsSent = (stats.turnsSent ?? 0) + sent.turns;
      stats.spansSent = (stats.spansSent ?? 0) + sent.spans;
      stats.tracesSent = (stats.tracesSent ?? 0) + (sent.traces ?? 0);
      stats.workflowsSent = (stats.workflowsSent ?? 0) + (sent.workflows ?? 0);
      stats.lastSuccessAt = this.now();
    });
  }

  async recordFailure(message: string): Promise<void> {
    await this.mutate<Stats>(STATS_KEY, emptyStats, (stats) => {
      stats.failures = (stats.failures ?? 0) + 1;
      stats.lastFailureAt = this.now();
      stats.lastError = message.slice(0, 300);
    });
  }
}

/** Runs `work` after everything already queued under `key`, whether that failed or not. */
function queue<T>(chains: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const next = (chains.get(key) ?? Promise.resolve()).then(work, work);
  chains.set(key, next);
  void next.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}
