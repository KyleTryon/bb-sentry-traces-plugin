/**
 * Storage keys and limits of the export: how much is read, how often a retry
 * waits, and how long finished runs are kept.
 */

export const THREAD_KEY = "thread:";
/** One key per entry, so concurrent writers never overwrite each other's entries. */
export const RETRY_PREFIX = "retry:";
export const TRACE_PREFIX = "trace:";
export const WORKFLOW_PREFIX = "workflow:";
export const STATS_KEY = "stats";
/** Where 0.1.0 kept the same entries as one map per kind; moved over once. */
export const LEGACY_KEYS = { retry: RETRY_PREFIX, traces: TRACE_PREFIX, workflows: WORKFLOW_PREFIX } as const;

export const PAGE_SIZE = 100;
/** One read covers at most this many pages of matching events. */
export const MAX_PAGES = 400;
/**
 * A read that ends inside a turn goes on to that turn's end, up to this many
 * pages in all: a turn longer than one read would otherwise never be seen
 * finished, and would hold back every turn after it.
 */
export const MAX_PAGES_LONG_TURN = 4_000;
/**
 * A thread never sent before starts with its newest turn. When its history is
 * longer than one read, an export reads on through at most this many more
 * before it leaves the rest to the next export.
 */
export const MAX_CATCH_UP_READS = 4;
/** Ids kept for a turn cut short; past this, a few of its spans may be sent twice. */
export const MAX_PARTIAL_IDS = 4_000;
/** After a long gap, only the newest turns are sent. */
export const MAX_TURNS_PER_EXPORT = 25;
export const MAX_RETRY_ATTEMPTS = 8;
export const MAX_RETRY_ENTRIES = 200;
export const MAX_RUN_ENTRIES = 200;
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 60 * 60_000;
/** An unanswered prompt older than this no longer holds the read position back. */
export const REQUEST_WINDOW_MS = 24 * 60 * 60_000;
export const SENT_RUN_KEEP_MS = 24 * 60 * 60_000;
export const OPEN_RUN_KEEP_MS = 30 * 24 * 60 * 60_000;
/**
 * How long a finished workflow waits for a span of its provider's trace to
 * name it. A provider may only learn that when it handles the workflow's result.
 */
export const WORKFLOW_LINK_WAIT_MS = 10 * 60_000;
/**
 * How long a finished turn waits for a background subagent it started. Its
 * agent's end comes in after the turn's, and a sent turn is never read again.
 */
export const BACKGROUND_AGENT_WAIT_MS = 2 * 60 * 60_000;
/** How often a waiting turn is looked at again: sooner while its wait is young. */
export const WAIT_CHECK_MIN_MS = 60_000;
export const WAIT_CHECK_MAX_MS = 15 * 60_000;
/** At most this many waiting turns are remembered per thread. */
export const MAX_WAITING_TURNS = 50;
