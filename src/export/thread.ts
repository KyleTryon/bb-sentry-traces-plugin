/**
 * Exports one thread: the turns that finished since the last export, sent one
 * at a time, with a turn held back while its background agent still works.
 */

import type { OtlpSpan, ResourceInfo } from "../core/otlp.js";
import type { Turn } from "../core/trace/types.js";
import { costDelta, isEmptyUsage, toSentryUsage, usageDelta } from "../core/usage.js";
import {
  BACKGROUND_AGENT_WAIT_MS,
  MAX_CATCH_UP_READS,
  MAX_PARTIAL_IDS,
  MAX_TURNS_PER_EXPORT,
  MAX_WAITING_TURNS,
  THREAD_KEY,
  WAIT_CHECK_MAX_MS,
  WAIT_CHECK_MIN_MS,
} from "./constants.js";
import { placeNow, placeThread } from "./location.js";
import { fold, readCostTotal, readUsage, readsOn, resumePoint } from "./read.js";
import { clearRetry, scheduleCheck, scheduleRetry } from "./retries.js";
import { noteTrace, noteWorkflow } from "./runs.js";
import { resourceOf, stillSending, targetOf } from "./settings.js";
import { type TurnUsage, turnSpans } from "./spans.js";
import { fromBeforeGap, kv, recordFailure, recordSuccess, sendingSince } from "./store.js";
import type { ExportContext, ExportOutcome, Folded, ThreadState } from "./types.js";
import { contextForTurn } from "../integrations/providers/placement.js";
import type { TraceContext } from "../integrations/providers/types.js";
import { NOT_NOW } from "../integrations/workflows/client.js";
import type { WorkflowContext } from "../integrations/workflows/ids.js";
import { type SendResult, type SentryTarget, sendSpans } from "../sentry.js";
import type { ThreadInfo } from "../thread.js";

const NO_TURNS: ReadonlySet<number> = new Set();

/** A subagent of the turn whose agent is still working in the background. */
function hasRunningAgent(turn: Turn): boolean {
  return turn.spans.some((span) => span.kind === "subagent" && span.end === null);
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
export async function previewThread(
  ctx: ExportContext,
  thread: ThreadInfo,
  options: { captureContent: boolean; turns: number | "all"; includeRunning?: boolean },
): Promise<{
  spans: OtlpSpan[];
  turns: number;
  trace: TraceContext | null;
  workflow: WorkflowContext | null;
}> {
  const folded = await fold(ctx, thread.id, undefined, options.captureContent);
  const eligible = options.includeRunning
    ? folded.turns
    : folded.turns.filter((turn) => turn.end !== null);
  const picked = options.turns === "all" ? eligible : eligible.slice(-options.turns);
  const usage = new Map<string, TurnUsage>();
  const newest = picked.at(-1);
  if (newest && picked.length === folded.turns.length) {
    const total = await readUsage(ctx, thread.id);
    if (total && !isEmptyUsage(total)) {
      usage.set(newest.id, {
        usage: toSentryUsage(total, thread.providerId),
        turns: picked.length,
      });
    } else {
      const cost = await readCostTotal(ctx, thread.id);
      if (cost) usage.set(newest.id, { usage: null, turns: picked.length, costUsd: cost });
    }
  }
  const { workflow, trace } = await placeNow(ctx, thread);
  const now = ctx.now();
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

/** The read a thread's export starts from, once its first reads are done. */
interface Read {
  state: ThreadState | undefined;
  folded: Folded;
}

/**
 * Turns held back for a background agent, then the finished turns after the
 * last one sent. After a long gap only the newest go; `skipped` counts the
 * others, whose tokens are still in the thread's total.
 */
function dueTurns(
  finished: Turn[],
  sentTurn: number | null,
  waitedBefore: ReadonlySet<number>,
): { due: Turn[]; skipped: number } {
  const held = finished.filter(
    (turn) => sentTurn !== null && turn.index <= sentTurn && waitedBefore.has(turn.index),
  );
  const after = sentTurn !== null ? finished.filter((turn) => turn.index > sentTurn) : finished.slice(-1);
  const fresh = after.slice(-MAX_TURNS_PER_EXPORT);
  return { due: [...held, ...fresh], skipped: after.length - fresh.length };
}

/**
 * A state from before sending was last turned on is read as a thread never
 * sent, still reading on from where it got to.
 */
function afterGap(state: ThreadState | undefined, since: number | null): ThreadState | undefined {
  if (!state || !fromBeforeGap(state, since)) return state;
  return { ...state, sentTurn: null, usage: null, cost: null, usageKnown: false, usageTurns: 0, waiting: null, partial: null };
}

/**
 * For a thread nothing of which was sent: the newest turn that finished
 * before sending was last turned on. It and the turns before it are not owed.
 */
function finishedBefore(finished: Turn[], since: number | null): number | null {
  if (since === null) return null;
  return finished.filter((turn) => turn.end !== null && turn.end < since).at(-1)?.index ?? null;
}

/**
 * Whether the thread's token total is known from here on. Without a noted
 * starting total, it is known when these turns are all the thread has. That is
 * decided once and remembered: a later export sees more turns and could not tell.
 */
function knowsTotal(state: ThreadState | undefined, folded: Folded, due: Turn[]): boolean {
  const whole =
    !folded.truncated && folded.turns.length === due.length && (folded.turns[0]?.index ?? 1) === 1;
  // A stored state that never read a total, never moved and never sent a
  // turn says no more than no state does.
  const untouched =
    !!state && state.usage === null && state.resumeSeq === 0 && (state.usageTurns ?? 0) === 0;
  return state ? state.usageKnown || (untouched && whole) : whole;
}

/**
 * A turn whose background subagent still works waits for it; the turns after
 * it go on without it. Gives whether a turn waits, and when the soonest
 * waiting turn is looked at again.
 */
function waitingOn(due: readonly Turn[], now: number) {
  const waits = (turn: Turn) =>
    hasRunningAgent(turn) && now - (turn.end ?? now) < BACKGROUND_AGENT_WAIT_MS;
  const waitUntil = due.filter(waits).reduce<number | null>((soonest, turn) => {
    const ended = turn.end ?? now;
    const step = Math.min(WAIT_CHECK_MAX_MS, Math.max(WAIT_CHECK_MIN_MS, now - ended));
    const at = Math.min(ended + BACKGROUND_AGENT_WAIT_MS + 1_000, now + step);
    return soonest === null ? at : Math.min(soonest, at);
  }, null);
  return { waits, waitUntil };
}

/**
 * Turning the plugin on sends what finishes from now on, not the whole
 * history: a thread never sent before reads on to its newest turns. Each
 * read stops short of the newest finished turn it saw, so the next read
 * still has that turn when no later one has finished.
 */
async function catchUp(
  ctx: ExportContext,
  thread: ThreadInfo,
  captureContent: boolean,
  start: ThreadState | undefined,
  first: Folded,
): Promise<Read | ExportOutcome> {
  const key = THREAD_KEY + thread.id;
  let state = start;
  let folded = first;
  for (let reads = 0; folded.truncated && (state?.sentTurn ?? null) === null; reads++) {
    const newest = folded.turns.filter((turn) => turn.end !== null).at(-1);
    let point = resumePoint(ctx, folded, state, newest ? newest.index - 1 : null, NO_TURNS);
    // The read began with that turn, and there are more events than it took
    // in: a later turn may have finished in them, so try reading on past it.
    let past = false;
    if (newest && point.resumeSeq <= (state?.resumeSeq ?? 0)) {
      point = resumePoint(ctx, folded, state, newest.index, NO_TURNS);
      past = true;
    }
    const next: ThreadState = {
      sentTurn: null,
      ...point,
      usage: state?.usage ?? null,
      usageKnown: state?.usageKnown ?? false,
      partial: null,
      updatedAt: ctx.now(),
    };
    // Held back by a turn or prompt it cannot read past: export from what was read.
    if (next.resumeSeq <= (state?.resumeSeq ?? 0)) break;
    if (reads >= MAX_CATCH_UP_READS) {
      // Past a turn that may still be the newest finished one, nothing is
      // saved: the next export starts at this read and looks ahead first.
      if (!past) await kv(ctx).set(key, next);
      ctx.bb.log.debug(`Thread ${thread.id} has a long history; the next export reads on.`);
      return { kind: "nothing" };
    }
    const ahead = await fold(ctx, thread.id, next, captureContent);
    // No later turn has finished, so the turn read past is still the newest
    // finished one: export it from this read, which still has it.
    if (past && !ahead.turns.some((turn) => turn.end !== null)) break;
    await kv(ctx).set(key, next);
    state = next;
    folded = ahead;
  }
  return { state, folded };
}

/** Nothing is due: remember where the read got to, and check again only when there is more to read. */
async function settleIdle(
  ctx: ExportContext,
  thread: ThreadInfo,
  state: ThreadState | undefined,
  folded: Folded,
  sentTurn: number | null,
): Promise<ExportOutcome> {
  const key = THREAD_KEY + thread.id;
  const point = resumePoint(ctx, folded, state, sentTurn, NO_TURNS);
  if (state) {
    await kv(ctx).set(key, {
      ...state,
      sentTurn,
      waiting: null,
      ...point,
      updatedAt: ctx.now(),
    } satisfies ThreadState);
  }
  // A retry that finds nothing left to send is done, unless there is more to read.
  if (state && readsOn(folded, state, point)) await scheduleCheck(ctx, thread.id, ctx.now());
  else await clearRetry(ctx, thread.id);
  return { kind: "nothing" };
}

/** What one export sends. */
interface Plan {
  thread: ThreadInfo;
  captureContent: boolean;
  target: SentryTarget;
  resource: ResourceInfo;
  due: Turn[];
  waits: (turn: Turn) => boolean;
  workflow: WorkflowContext | null;
  trace: TraceContext | null;
  usage: ReadonlyMap<string, TurnUsage>;
  partial: { turnId: string; spanIds: string[] } | null;
  baseline: number;
  now: number;
}

/** What sending the due turns came to. */
interface Sending {
  done: Set<number>;
  lastDone: number;
  cut: { turnId: string; spanIds: string[] } | null;
  failure: SendResult | null;
  refused: SendResult | null;
  /** Sending was turned off, moved to another DSN or the plugin unloaded part way. */
  stopped: boolean;
  usageSent: boolean;
  turnsSent: number;
  spansSent: number;
  traceIds: Set<string>;
}

/**
 * Sends the due turns one at a time, so a failure leaves the turns before it
 * sent and the spans Sentry already took are never sent again. The settings
 * are read again before each turn: sending stops, with nothing counted as
 * failed, once they no longer send to the same place.
 */
async function sendTurns(ctx: ExportContext, plan: Plan): Promise<Sending> {
  const { thread, due, waits, workflow, trace, usage, partial, baseline, now } = plan;
  let lastDone = baseline;
  const done = new Set<number>();
  let cut: { turnId: string; spanIds: string[] } | null = null;
  let failure: SendResult | null = null;
  let refused: SendResult | null = null;
  let stopped = false;
  let usageSent = false;
  let turnsSent = 0;
  let spansSent = 0;
  const traceIds = new Set<string>();
  for (const turn of due) {
    if (waits(turn)) {
      // Passed over for now; it is remembered as waiting.
      lastDone = Math.max(lastDone, turn.index);
      continue;
    }
    if (!(await stillSending(ctx, plan.target))) {
      stopped = true;
      break;
    }
    const all = turnSpans(turn, {
      thread,
      trace: contextForTurn(turn, trace),
      workflow,
      captureContent: plan.captureContent,
      now,
      usage,
    });
    const already = partial?.turnId === turn.id ? new Set(partial.spanIds) : null;
    const spans = already ? all.filter((span) => !already.has(span.spanId)) : all;
    const result = await sendSpans(plan.target, spans, plan.resource, ctx.fetch);
    const accepted = spans.slice(0, result.spans);
    spansSent += accepted.length;
    for (const span of accepted) traceIds.add(span.traceId);
    if (result.ok) {
      done.add(turn.index);
      lastDone = Math.max(lastDone, turn.index);
      turnsSent++;
      if (usage.has(turn.id)) usageSent = true;
      continue;
    }
    if (result.payloadRejected) {
      // Sentry would refuse these spans again: give the turn up so the turns after it still go.
      ctx.bb.log.warn(`Sentry refused turn ${turn.index} of ${thread.id}, which is skipped: ${result.message}`);
      await recordFailure(ctx, result.message);
      refused = result;
      done.add(turn.index);
      lastDone = Math.max(lastDone, turn.index);
      continue;
    }
    failure = result;
    cut = {
      turnId: turn.id,
      spanIds: [...(already ?? []), ...accepted.map((span) => span.spanId)].slice(0, MAX_PARTIAL_IDS),
    };
    break;
  }
  return { done, lastDone, cut, failure, refused, stopped, usageSent, turnsSent, spansSent, traceIds };
}

export async function exportThread(ctx: ExportContext, thread: ThreadInfo): Promise<ExportOutcome> {
  const settings = await ctx.settings();
  if (!settings.enabled) return { kind: "disabled" };
  const resolved = targetOf(settings);
  if ("reason" in resolved) return { kind: "not-configured" };

  const key = THREAD_KEY + thread.id;
  const since = await sendingSince(ctx);
  const start = afterGap(await kv(ctx).get<ThreadState>(key), since);
  const caught = await catchUp(
    ctx,
    thread,
    settings.captureContent,
    start,
    await fold(ctx, thread.id, start, settings.captureContent),
  );
  if ("kind" in caught) return caught;
  const { state, folded } = caught;
  if (folded.truncated) {
    ctx.bb.log.warn(`Thread ${thread.id} has more events than one export reads; its newest turns may wait.`);
  }

  const finished = folded.turns.filter((turn) => turn.end !== null);
  // Turning the plugin on sends the turns that finish from then on.
  const sentTurn = state?.sentTurn ?? finishedBefore(finished, since);
  const waitedBefore = new Set(state?.waiting ?? []);
  const { due, skipped } = dueTurns(finished, sentTurn, waitedBefore);
  const [oldestDue] = due;
  if (oldestDue === undefined) return settleIdle(ctx, thread, state, folded, sentTurn);

  const now = ctx.now();
  // A thread never sent before starts at its newest turn: the turns before
  // it count as done, so a first export that fails or waits keeps that turn.
  const baseline = sentTurn ?? oldestDue.index - 1;
  const knownTotal = knowsTotal(state, folded, due);
  const { waits, waitUntil } = waitingOn(due, now);
  const pending = due.filter((turn) => !waits(turn));
  let workflow: WorkflowContext | null = null;
  let trace: TraceContext | null = null;
  if (pending.length > 0) {
    const placed = await placeThread(ctx, thread);
    // Workflows failed for a moment: sent now, the worker's turns would be outside its run for good.
    if (placed === NOT_NOW) {
      await scheduleCheck(ctx, thread.id, now + WAIT_CHECK_MIN_MS);
      return { kind: "nothing" };
    }
    ({ workflow, trace } = placed);
  }

  // While a turn waits, its tokens so far are in the thread's total too, and
  // the total cannot be split by turn: the usage waits with it.
  const usageWaitsForTurn = pending.length < due.length;
  const usageTurns = state?.usageTurns ?? 0;
  const current = pending.length > 0 ? await readUsage(ctx, thread.id) : null;
  // Without tokens, an agent's own running cost stands in for them.
  const currentCost = pending.length > 0 && !current ? await readCostTotal(ctx, thread.id) : null;
  const usage = new Map<string, TurnUsage>();
  const newestPending = pending.at(-1);
  const covered = pending.length + usageTurns + skipped;
  if (newestPending && !usageWaitsForTurn && current && knownTotal) {
    const delta = usageDelta(current, state?.usage ?? null);
    if (delta && !isEmptyUsage(delta)) {
      // One span of one turn carries it, so cost is never counted twice.
      usage.set(newestPending.id, { usage: toSentryUsage(delta, thread.providerId), turns: covered });
    }
  } else if (newestPending && !usageWaitsForTurn && currentCost !== null && knownTotal) {
    const delta = costDelta(currentCost, state?.cost ?? null);
    if (delta) usage.set(newestPending.id, { usage: null, turns: covered, costUsd: delta });
  }

  const sending = await sendTurns(ctx, {
    thread,
    captureContent: settings.captureContent,
    target: resolved.target,
    resource: resourceOf(settings),
    due,
    waits,
    workflow,
    trace,
    usage,
    partial: state?.partial ?? null,
    baseline,
    now,
  });
  const { done, lastDone, cut, failure, refused, stopped, usageSent, turnsSent, spansSent, traceIds } = sending;

  // Turns at or before the last one done that are not done: they wait, or
  // waited and could not be sent this time.
  const waiting = due
    .filter((turn) => turn.index <= lastDone && !done.has(turn.index))
    .map((turn) => turn.index)
    .slice(-MAX_WAITING_TURNS);
  // The usage span goes last, so a turn that was cut short or refused never
  // sent it: the next export counts it again from the same starting total.
  const usageStays = usageWaitsForTurn || (usage.size > 0 && !usageSent);
  const point = resumePoint(ctx, folded, state, lastDone, new Set(waiting));
  await kv(ctx).set(key, {
    sentTurn: lastDone,
    waiting: waiting.length > 0 ? waiting : null,
    ...point,
    usage: usageStays ? (state?.usage ?? null) : (current ?? state?.usage ?? null),
    cost: usageStays ? (state?.cost ?? null) : (currentCost ?? state?.cost ?? null),
    usageKnown: usageStays ? knownTotal : true,
    usageTurns: usageStays ? usageTurns + done.size : 0,
    partial: cut && cut.spanIds.length > 0 ? cut : null,
    updatedAt: now,
  } satisfies ThreadState);
  if (spansSent > 0) {
    await recordSuccess(ctx, { turns: turnsSent, spans: spansSent });
    // Turns that started after the trace ended are the thread's own.
    const inTrace = pending.some((turn) => contextForTurn(turn, trace) !== null);
    if (trace && inTrace) await noteTrace(ctx, trace);
    if (workflow) await noteWorkflow(ctx, workflow, inTrace ? trace : null);
  }
  if (failure) return failed(ctx, thread.id, failure, waitUntil);
  // Finished turns may sit in the events this read did not take in, and
  // turns a stop left unsent go once sending is on again.
  const checkAt = stopped || readsOn(folded, state, point) ? now : waitUntil;
  if (checkAt !== null) await scheduleCheck(ctx, thread.id, checkAt, turnsSent > 0);
  else await clearRetry(ctx, thread.id);
  if (turnsSent === 0 && refused) {
    return { kind: "failed", message: refused.message, retryable: false };
  }
  if (pending.length === 0 || (stopped && turnsSent === 0)) return { kind: "nothing" };
  return { kind: "sent", turns: turnsSent, spans: spansSent, traceIds: [...traceIds] };
}

/**
 * A failed send: retried later, backing off. A rejected key fails the same
 * way again, so it is not retried, and the next turn tries anyway; turns
 * waiting on a background agent are still looked at by `waitUntil`.
 */
async function failed(
  ctx: ExportContext,
  threadId: string,
  result: SendResult,
  waitUntil: number | null,
): Promise<ExportOutcome> {
  ctx.bb.log.warn(`Could not send the trace of ${threadId}: ${result.message}`);
  await recordFailure(ctx, result.message);
  if (result.retryable) await scheduleRetry(ctx, threadId, waitUntil);
  else if (waitUntil !== null) await scheduleCheck(ctx, threadId, waitUntil);
  else await clearRetry(ctx, threadId);
  return { kind: "failed", message: result.message, retryable: result.retryable };
}
