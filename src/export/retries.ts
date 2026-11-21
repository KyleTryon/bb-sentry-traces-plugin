/** Retries of failed exports, and checks of threads that are waiting on something. */
import { MAX_RETRY_ATTEMPTS, MAX_RETRY_ENTRIES, RETRY_BASE_MS, RETRY_MAX_MS, RETRY_PREFIX } from "./constants.js";
import { entries, kv, trim } from "./store.js";
import { type ExportContext, type RetryEntry } from "./types.js";

export function retries(ctx: ExportContext): Promise<Record<string, RetryEntry>> {
  return entries<RetryEntry>(ctx, RETRY_PREFIX);
}

export async function scheduleRetry(ctx: ExportContext, threadId: string): Promise<void> {
  const key = RETRY_PREFIX + threadId;
  const attempts = ((await kv(ctx).get<RetryEntry>(key))?.attempts ?? 0) + 1;
  if (attempts > MAX_RETRY_ATTEMPTS) {
    await kv(ctx).delete(key);
    ctx.bb.log.warn(`Gave up retrying the trace of ${threadId}; its next turn will try again.`);
    return;
  }
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1));
  await kv(ctx).set(key, { attempts, nextAt: ctx.now() + delay } satisfies RetryEntry);
  // The entries due soonest go first when the queue is full.
  await trim<RetryEntry>(ctx, RETRY_PREFIX, MAX_RETRY_ENTRIES, (entry) => entry.nextAt);
}

/**
 * Looks at a thread again at `at` without counting a failed attempt: it is
 * waiting on something, not failing. A failure's count is kept.
 */
export async function scheduleCheck(ctx: ExportContext, threadId: string, at: number): Promise<void> {
  const key = RETRY_PREFIX + threadId;
  const attempts = (await kv(ctx).get<RetryEntry>(key))?.attempts ?? 0;
  await kv(ctx).set(key, { attempts, nextAt: at } satisfies RetryEntry);
  await trim<RetryEntry>(ctx, RETRY_PREFIX, MAX_RETRY_ENTRIES, (entry) => entry.nextAt);
}

export async function clearRetry(ctx: ExportContext, threadId: string): Promise<void> {
  await kv(ctx).delete(RETRY_PREFIX + threadId);
}
