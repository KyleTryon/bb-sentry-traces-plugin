/**
 * Storage for the export: per-thread state, retries, provider traces, workflow
 * runs and stats. Shared records are changed one at a time under a lock, and
 * every other entry is stored under a key of its own.
 */
import { queue } from "../core/queue.js";
import { LEGACY_KEYS, SENDING_SINCE_KEY, STATS_KEY } from "./constants.js";
import { type ExportContext, type Stats, type ThreadState } from "./types.js";

export function kv(ctx: ExportContext) {
  return ctx.bb.storage.kv;
}

/** When sending last became possible after it was not, or null if it never did while loaded. */
export async function sendingSince(ctx: ExportContext): Promise<number | null> {
  return (await kv(ctx).get<number>(SENDING_SINCE_KEY)) ?? null;
}

/**
 * Whether a thread's state is from before sending was last turned on. It then
 * says nothing about what Sentry has: the turns of the gap were never sent,
 * and are not owed, and the token total it noted is from before the gap.
 */
export function fromBeforeGap(state: ThreadState, since: number | null): boolean {
  return since !== null && state.updatedAt < since;
}

/** Changes a shared storage record in place; `change` returns false to leave it as it was. */
export function mutate<T>(ctx: ExportContext, key: string, empty: () => T, change: (value: T) => boolean | void): Promise<void> {
  return queue(ctx.locks, key, async () => {
    const value = (await kv(ctx).get<T>(key)) ?? empty();
    if (change(value) !== false) await kv(ctx).set(key, value);
  });
}

/** Every entry stored under `prefix`, by the rest of its key. */
export async function entries<T>(ctx: ExportContext, prefix: string): Promise<Record<string, T>> {
  const found: Record<string, T> = {};
  for (const key of await kv(ctx).list(prefix)) {
    const value = await kv(ctx).get<T>(key);
    if (value !== undefined) found[key.slice(prefix.length)] = value;
  }
  return found;
}

/**
 * Keeps at most `max` entries under `prefix`, dropping those that sort first
 * by `dropFirst`. `dropped` is told of each, to drop what goes with it.
 */
export async function trim<T>(
  ctx: ExportContext,
  prefix: string,
  max: number,
  dropFirst: (a: T, b: T) => number,
  dropped: (entry: T) => Promise<void> = async () => undefined,
): Promise<void> {
  const keys = await kv(ctx).list(prefix);
  if (keys.length <= max) return;
  const all = Object.entries(await entries<T>(ctx, prefix)).sort(([, a], [, b]) => dropFirst(a, b));
  for (const [id, entry] of all.slice(0, Math.max(0, all.length - max))) {
    await kv(ctx).delete(prefix + id);
    await dropped(entry);
  }
}

/** Moves 0.1.0's one-map-per-kind records to one key per entry. */
export async function migrate(ctx: ExportContext): Promise<void> {
  if (ctx.migrated) return;
  for (const [legacy, prefix] of Object.entries(LEGACY_KEYS)) {
    const map = await kv(ctx).get<Record<string, unknown>>(legacy);
    if (map === undefined) continue;
    for (const [id, entry] of Object.entries(map ?? {})) {
      if ((await kv(ctx).get(prefix + id)) === undefined) await kv(ctx).set(prefix + id, entry);
    }
    await kv(ctx).delete(legacy);
  }
  ctx.migrated = true;
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

export async function recordSuccess(
  ctx: ExportContext,
  sent: { turns: number; spans: number; traces?: number; workflows?: number },
): Promise<void> {
  await mutate<Stats>(ctx, STATS_KEY, emptyStats, (stats) => {
    stats.turnsSent = (stats.turnsSent ?? 0) + sent.turns;
    stats.spansSent = (stats.spansSent ?? 0) + sent.spans;
    stats.tracesSent = (stats.tracesSent ?? 0) + (sent.traces ?? 0);
    stats.workflowsSent = (stats.workflowsSent ?? 0) + (sent.workflows ?? 0);
    stats.lastSuccessAt = ctx.now();
  });
}

export async function recordFailure(ctx: ExportContext, message: string): Promise<void> {
  await mutate<Stats>(ctx, STATS_KEY, emptyStats, (stats) => {
    stats.failures = (stats.failures ?? 0) + 1;
    stats.lastFailureAt = ctx.now();
    stats.lastError = message.slice(0, 300);
  });
}
