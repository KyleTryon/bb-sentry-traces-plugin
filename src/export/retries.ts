/** Retries of failed exports, and checks of threads that are waiting on something. */
import { MAX_RETRY_ATTEMPTS, MAX_RETRY_ENTRIES, RETRY_BASE_MS, RETRY_MAX_MS, RETRY_PREFIX } from "./constants.js";
import { entries, kv, trim } from "./store.js";
import { type ExportContext, type RetryEntry } from "./types.js";

export function retries(ctx: ExportContext): Promise<Record<string, RetryEntry>> {
  return entries<RetryEntry>(ctx, RETRY_PREFIX);
}

/**
 * When the queue is full, the entries that failed most go first, then those
 * due latest: a check due now, such as a read that goes on or a turn waiting
 * on its background agent, is the last to be dropped.
 */
function dropFirst(a: RetryEntry, b: RetryEntry): number {
  return b.attempts - a.attempts || b.nextAt - a.nextAt;
}

/**
 * Counts a failed attempt and tries again later, backing off. After the last
 * attempt it gives up, but a thread with turns waiting on a background agent
 * is still looked at by `waitUntil`: nothing else would send those turns.
 */
export async function scheduleRetry(
  ctx: ExportContext,
  threadId: string,
  waitUntil: number | null = null,
): Promise<void> {
  const key = RETRY_PREFIX + threadId;
  const attempts = ((await kv(ctx).get<RetryEntry>(key))?.attempts ?? 0) + 1;
  if (attempts > MAX_RETRY_ATTEMPTS) {
    ctx.bb.log.warn(`Gave up retrying the trace of ${threadId}; its next turn will try again.`);
    // Kept at the last attempt, so a check that fails again gives up at once.
    if (waitUntil !== null) await scheduleCheck(ctx, threadId, waitUntil);
    else await kv(ctx).delete(key);
    return;
  }
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
  await kv(ctx).set(key, { attempts, nextAt: ctx.now() + delay } satisfies RetryEntry);
  await trim<RetryEntry>(ctx, RETRY_PREFIX, MAX_RETRY_ENTRIES, dropFirst);
}

/**
 * Looks at a thread again at `at` without counting a failed attempt: it is
 * waiting on something, not failing. A failure's count is kept, unless
 * `sent` says the export just got through: the failures before it are over.
 */
export async function scheduleCheck(ctx: ExportContext, threadId: string, at: number, sent = false): Promise<void> {
  const key = RETRY_PREFIX + threadId;
  const attempts = sent ? 0 : ((await kv(ctx).get<RetryEntry>(key))?.attempts ?? 0);
  await kv(ctx).set(key, { attempts: Math.min(attempts, MAX_RETRY_ATTEMPTS), nextAt: at } satisfies RetryEntry);
  await trim<RetryEntry>(ctx, RETRY_PREFIX, MAX_RETRY_ENTRIES, dropFirst);
}

export async function clearRetry(ctx: ExportContext, threadId: string): Promise<void> {
  await kv(ctx).delete(RETRY_PREFIX + threadId);
}
