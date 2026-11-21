/**
 * Reads a thread's events from where the last export stopped, folds them into
 * turns, and works out where the next export can resume.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { TraceBuilder } from "../core/trace/builder.js";
import { TRACE_EVENT_TYPES, type TraceEvent } from "../core/trace/types.js";
import { type RawUsage, readTotal } from "../core/usage.js";
import { MAX_PAGES, MAX_PAGES_LONG_TURN, PAGE_SIZE, REQUEST_WINDOW_MS } from "./constants.js";
import { type ExportContext, type Folded, type ThreadState } from "./types.js";

const EVENT_TYPES = [...TRACE_EVENT_TYPES] as unknown as Parameters<
  BbPluginApi["sdk"]["threads"]["events"]["list"]
>[0]["types"];

export async function readEvents(ctx: ExportContext, threadId: string, afterSeq: number, builder: TraceBuilder) {
  let cursor = afterSeq;
  // The turn a full read ended inside, which the read goes on to the end of.
  let inside: string | null = null;
  for (let page = 0; page < MAX_PAGES_LONG_TURN; page++) {
    if (page === MAX_PAGES) inside = builder.runningTurn;
    if (page >= MAX_PAGES && (inside === null || !builder.isRunning(inside))) return true;
    const rows = await ctx.bb.sdk.threads.events.list({
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

export async function fold(ctx: ExportContext, threadId: string, state: ThreadState | undefined, content: boolean) {
  const builder = new TraceBuilder({ content, indexOffset: state?.turnsBefore ?? 0 });
  const truncated = await readEvents(ctx, threadId, state?.resumeSeq ?? 0, builder);
  return { turns: builder.snapshot(ctx.now()), builder, truncated } satisfies Folded;
}

/** bb keeps only the latest usage event per thread: a running total. */
export async function readUsage(ctx: ExportContext, threadId: string): Promise<RawUsage | null> {
  const rows = await ctx.bb.sdk.threads.events.list({
    threadId,
    order: "desc",
    limit: "1",
    types: ["thread/tokenUsage/updated"],
  });
  return rows.length > 0 ? readTotal(rows[0].data) : null;
}

/**
 * Where the next export can start reading without losing a turn's prompt or
 * start: before every turn that is not done, including those still waiting.
 */
export function resumePoint(
  ctx: ExportContext,
  folded: Folded,
  state: ThreadState | undefined,
  sentTurn: number | null,
  waiting: ReadonlySet<number>,
) {
  const previous = state?.resumeSeq ?? 0;
  const candidates = [Math.max(previous, folded.builder.lastSeq)];
  for (const turn of folded.turns) {
    if (turn.end !== null && sentTurn !== null && turn.index <= sentTurn && !waiting.has(turn.index)) {
      continue;
    }
    candidates.push(Math.min(turn.firstSeq, turn.requestSeq ?? turn.firstSeq) - 1);
  }
  const unanswered = folded.builder.earliestUnmatchedRequest(ctx.now() - REQUEST_WINDOW_MS);
  if (unanswered !== null) candidates.push(unanswered - 1);
  const resumeSeq = Math.max(previous, Math.min(...candidates));
  const turnsBefore =
    (state?.turnsBefore ?? 0) + folded.turns.filter((turn) => turn.firstSeq <= resumeSeq).length;
  return { resumeSeq, turnsBefore };
}

/**
 * Whether an export should be followed by another without waiting for the
 * thread's next event: its read left events unread and got somewhere, so the
 * next read starts further on. A read that got nowhere would only repeat.
 */
export function readsOn(folded: Folded, state: ThreadState | undefined, point: { resumeSeq: number }): boolean {
  return folded.truncated && point.resumeSeq > (state?.resumeSeq ?? 0);
}
