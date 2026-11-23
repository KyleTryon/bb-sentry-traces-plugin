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
import { errorMessage } from "../core/text.js";
import { TraceProviders } from "../integrations/providers/client.js";
import { WorkflowsClient } from "../integrations/workflows/client.js";
import {
  DISPOSE_WAIT_MS,
  PRUNE_EVERY_MS,
  PRUNED_AT_KEY,
  RETRY_PREFIX,
  SENDING_SINCE_KEY,
  STATS_KEY,
  THREAD_KEEP_MS,
  THREAD_KEY,
} from "./constants.js";
import { readUsage } from "./read.js";
import { clearRetry, retries, scheduleRetry } from "./retries.js";
import { previewThread, exportThread } from "./thread.js";
import { sweepTraces, sweepWorkflows, traceEntries, workflowEntries } from "./runs.js";
import { targetOf } from "./settings.js";
import {
  emptyStats,
  fromBeforeGap,
  kv,
  migrate,
  queue,
  recordFailure,
  recordSuccess,
  sendingSince,
} from "./store.js";
import type { ExportContext, ExportOutcome, ExporterDeps, Stats, ThreadState } from "./types.js";
import { toThreadInfo, type ThreadInfo } from "../thread.js";

/** Waits for `work`, but no longer than `ms`. */
async function atMost(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([work.then(() => undefined), timeout]);
  clearTimeout(timer);
}

export class Exporter {
  readonly providers: TraceProviders;
  readonly workflows: WorkflowsClient;
  private readonly ctx: ExportContext;
  /** One export at a time per thread, so back-to-back events never send a turn twice. */
  private readonly chains = new Map<string, Promise<unknown>>();
  /** The periodic work running now, which unloading waits for. */
  private ticking: Promise<void> = Promise.resolve();
  /** The noting of when sending was turned on, which an export waits for. */
  private noting: Promise<void> = Promise.resolve();

  constructor(deps: ExporterDeps) {
    const now = deps.now ?? Date.now;
    this.providers = new TraceProviders(deps.bb, async () => (await deps.settings()).providers, now);
    this.workflows = new WorkflowsClient(deps.bb, now);
    this.ctx = {
      bb: deps.bb,
      settings: deps.settings,
      fetch: deps.fetch,
      now,
      providers: this.providers,
      workflows: this.workflows,
      locks: new Map(),
      migrated: false,
      disposed: false,
    };
  }

  /**
   * Stops all work at its next turn or entry, and waits a few seconds for what
   * is running to save what it sent: the instance that loads next exports the
   * same threads, and must not send those turns again.
   */
  async dispose(): Promise<void> {
    this.ctx.disposed = true;
    const running = [...this.chains.values(), this.ticking, this.noting];
    await atMost(DISPOSE_WAIT_MS, Promise.allSettled(running));
  }

  /**
   * Notes that sending just became possible after it was not: export turned
   * on, or a DSN set. Turning the plugin on sends the turns that finish from
   * then on, so what was remembered of a thread before is not built on.
   */
  noteSendingOn(): Promise<void> {
    const at = this.ctx.now();
    this.noting = this.noting
      .then(() => kv(this.ctx).set(SENDING_SINCE_KEY, at))
      .catch((cause: unknown) => {
        this.ctx.bb.log.warn(`Could not note that sending was turned on: ${errorMessage(cause)}`);
      });
    return this.noting;
  }

  /** Runs `work` after everything already queued for the thread. Never rejects. */
  private serialize<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    return queue(this.chains, threadId, work);
  }

  /** Queues an export of the thread. Safe to call from an event handler. */
  enqueue(thread: ThreadInfo): Promise<ExportOutcome> {
    return this.serialize(thread.id, async (): Promise<ExportOutcome> => {
      await this.noting;
      if (this.ctx.disposed) return { kind: "nothing" };
      try {
        return await exportThread(this.ctx, thread);
      } catch (cause) {
        const message = errorMessage(cause);
        this.ctx.bb.log.warn(`Could not export thread ${thread.id}: ${message}`);
        await recordFailure(this.ctx, message).catch(() => undefined);
        await scheduleRetry(this.ctx, thread.id).catch(() => undefined);
        return { kind: "failed", message, retryable: true };
      }
    });
  }

  /**
   * Remembers a thread's token total when a turn starts on a thread that has
   * never been exported, or not since sending was turned on, so the first
   * exported turn is not charged with the thread's history or the gap's.
   */
  noteActive(threadId: string): Promise<void> {
    return this.serialize(threadId, async () => {
      await this.noting;
      if (this.ctx.disposed) return;
      try {
        const settings = await this.ctx.settings();
        if (!settings.enabled || "reason" in targetOf(settings)) return;
        const state = await kv(this.ctx).get<ThreadState>(THREAD_KEY + threadId);
        if (state && !fromBeforeGap(state, await sendingSince(this.ctx))) return;
        // Where the read got to still holds: only what was sent is from before.
        await kv(this.ctx).set(THREAD_KEY + threadId, {
          sentTurn: null,
          resumeSeq: state?.resumeSeq ?? 0,
          turnsBefore: state?.turnsBefore ?? 0,
          usage: await readUsage(this.ctx, threadId),
          usageKnown: true,
          updatedAt: this.ctx.now(),
        } satisfies ThreadState);
      } catch (cause) {
        this.ctx.bb.log.debug(`Could not note the start of ${threadId}: ${errorMessage(cause)}`);
      }
    });
  }

  /** Drops what is kept about a deleted thread, after any export of it still running. */
  forget(threadId: string): Promise<void> {
    return this.serialize(threadId, async () => {
      try {
        await kv(this.ctx).delete(THREAD_KEY + threadId);
        await kv(this.ctx).delete(RETRY_PREFIX + threadId);
      } catch (cause) {
        this.ctx.bb.log.debug(`Could not forget ${threadId}: ${errorMessage(cause)}`);
      }
    });
  }

  /** The spans for a thread's turns, without sending anything or changing what is remembered. */
  preview(
    thread: ThreadInfo,
    options: { captureContent: boolean; turns: number | "all"; includeRunning?: boolean },
  ): ReturnType<typeof previewThread> {
    return previewThread(this.ctx, thread, options);
  }

  /** Periodic work: retry failed exports that are due, send runs that ended, and prune. */
  tick(): Promise<void> {
    const run = this.ticking.then(() => this.periodic());
    this.ticking = run;
    return run;
  }

  private async periodic(): Promise<void> {
    if (this.ctx.disposed) return;
    try {
      const settings = await this.ctx.settings();
      if (!settings.enabled) return;
      const resolved = targetOf(settings);
      if ("reason" in resolved) return;
      await migrate(this.ctx);

      const queued = await retries(this.ctx);
      const now = this.ctx.now();
      for (const [threadId, entry] of Object.entries(queued)) {
        if (entry.nextAt > now || this.ctx.disposed) continue;
        const thread = await this.threadInfo(threadId);
        if (!thread) {
          await clearRetry(this.ctx, threadId);
          continue;
        }
        await this.enqueue(thread);
      }
      await sweepTraces(this.ctx, resolved.target);
      await sweepWorkflows(this.ctx, resolved.target);
      await this.prune();
    } catch (cause) {
      this.ctx.bb.log.warn(`Periodic export work failed: ${errorMessage(cause)}`);
    }
  }

  /**
   * At most once a day, drops what is kept of threads untouched for months
   * and not waiting on a retry: storage otherwise only grows, since only a
   * deleted thread is forgotten. Such a thread used again starts afresh.
   */
  private async prune(): Promise<void> {
    const now = this.ctx.now();
    const last = await kv(this.ctx).get<number>(PRUNED_AT_KEY);
    if (last !== undefined && now - last < PRUNE_EVERY_MS) return;
    await kv(this.ctx).set(PRUNED_AT_KEY, now);
    const retrying = new Set(await kv(this.ctx).list(RETRY_PREFIX));
    for (const key of await kv(this.ctx).list(THREAD_KEY)) {
      if (this.ctx.disposed) return;
      const threadId = key.slice(THREAD_KEY.length);
      if (retrying.has(RETRY_PREFIX + threadId)) continue;
      const state = await kv(this.ctx).get<ThreadState>(key);
      if (!state || now - state.updatedAt <= THREAD_KEEP_MS) continue;
      // After any export of it still running, which may have just used it.
      await this.serialize(threadId, async () => {
        const latest = await kv(this.ctx).get<ThreadState>(key);
        if (!latest || this.ctx.now() - latest.updatedAt <= THREAD_KEEP_MS) return;
        if ((await kv(this.ctx).get(RETRY_PREFIX + threadId)) === undefined) await kv(this.ctx).delete(key);
      });
    }
  }

  async threadInfo(threadId: string): Promise<ThreadInfo | null> {
    try {
      return toThreadInfo(await this.ctx.bb.sdk.threads.get({ threadId }));
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------- stats

  async stats(): Promise<Stats> {
    return { ...emptyStats(), ...((await kv(this.ctx).get<Stats>(STATS_KEY)) ?? {}) };
  }

  async queueSizes(): Promise<{ retries: number; openTraces: number; openWorkflows: number }> {
    const open = (entries: Record<string, { sentAt: number | null }>) =>
      Object.values(entries).filter((entry) => entry.sentAt === null).length;
    return {
      retries: Object.keys(await retries(this.ctx)).length,
      openTraces: open(await traceEntries(this.ctx)),
      openWorkflows: open(await workflowEntries(this.ctx)),
    };
  }

  recordSuccess(sent: { turns: number; spans: number; traces?: number; workflows?: number }): Promise<void> {
    return recordSuccess(this.ctx, sent);
  }

  recordFailure(message: string): Promise<void> {
    return recordFailure(this.ctx, message);
  }
}
