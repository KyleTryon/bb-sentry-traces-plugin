/**
 * Where an agent's time went, moment by moment: every stretch of a turn is
 * waiting on the user, starting up, compacting, running tools, waiting on
 * subagents, writing, thinking, or, when nothing else explains it, the model
 * (response latency and writing tool calls, which providers do not stream).
 *
 * Adapted from bb-plugin-agent-traces (https://github.com/charpeni/bb-plugins,
 * plugins/agent-traces/breakdown.ts), MIT License, Copyright (c) 2026 Nicolas
 * Charpentier. See THIRD_PARTY_NOTICES.md. Trimmed to the timing sweep.
 */
import type { Span, SpanKind, Turn } from "./trace.js";

/** Most to least specific: when two overlap, the earlier one names the moment. */
export const PHASES = [
  "waiting",
  "startup",
  "compaction",
  "tools",
  "subagents",
  "writing",
  "thinking",
  "model",
] as const;
export type Phase = (typeof PHASES)[number];

/** The phases that are the model's own time. */
export const MODEL_PHASES: ReadonlySet<Phase> = new Set(["writing", "thinking", "model"]);

const SPAN_PHASES: Partial<Record<SpanKind, Phase>> = {
  waiting: "waiting",
  startup: "startup",
  compaction: "compaction",
  subagent: "subagents",
  command: "tools",
  tool: "tools",
  read: "tools",
  edit: "tools",
  search: "tools",
  web: "tools",
};

export interface Segment {
  phase: Phase;
  start: number;
  end: number;
}

/** The part of a turn the timing math needs. */
export type TimedTurn = Pick<Turn, "start" | "end" | "spans" | "activity">;

/**
 * One agent's time, split into phases. `lane` is a subagent span id, or null
 * for the turn's own agent. Background work runs alongside the agent, so it
 * never takes a moment away from what the agent itself was doing.
 */
export function laneBreakdown(turn: TimedTurn, lane: string | null, now: number): Segment[] {
  const owner = lane === null ? turn : turn.spans.find((span) => span.id === lane);
  if (!owner) return [];
  const from = owner.start;
  const to = owner.end ?? Math.max(now, owner.start);
  if (to <= from) return [];

  const intervals: Array<{ rank: number; start: number; end: number }> = [];
  const add = (phase: Phase, start: number, end: number | null) => {
    const clippedStart = Math.max(start, from);
    const clippedEnd = Math.min(end ?? to, to);
    if (clippedEnd > clippedStart) {
      intervals.push({ rank: PHASES.indexOf(phase), start: clippedStart, end: clippedEnd });
    }
  };
  for (const span of turn.spans) {
    const phase = SPAN_PHASES[span.kind];
    if (span.parentId === lane && !span.background && phase) add(phase, span.start, span.end);
  }
  for (const activity of turn.activity) {
    if (activity.lane === lane) add(activity.kind, activity.start, activity.end);
  }

  // Sweep the edges, keeping a count of each phase in play.
  const edges = intervals.flatMap(({ rank, start, end }) => [
    { at: start, rank, delta: 1 },
    { at: end, rank, delta: -1 },
  ]);
  edges.sort((a, b) => a.at - b.at);
  const counts = Array.from({ length: PHASES.length }, () => 0);
  const modelRank = PHASES.indexOf("model");
  const segments: Segment[] = [];
  let cursor = from;
  let index = 0;
  const emit = (until: number) => {
    if (until <= cursor) return;
    const rank = counts.findIndex((count) => count > 0);
    const phase = PHASES[rank === -1 ? modelRank : rank];
    const last = segments.at(-1);
    if (last && last.phase === phase && last.end === cursor) last.end = until;
    else segments.push({ phase, start: cursor, end: until });
    cursor = until;
  };
  while (index < edges.length) {
    const at = edges[index].at;
    emit(at);
    while (index < edges.length && edges[index].at === at) {
      counts[edges[index].rank] += edges[index].delta;
      index++;
    }
  }
  emit(to);
  return segments;
}

/** A stretch of the model's own time: adjacent thinking, writing and unexplained segments joined. */
export interface ModelStretch {
  start: number;
  end: number;
  phases: Phase[];
}

/**
 * The turn's own agent's model time. Thinking, writing and unexplained
 * stretches that touch are one model request as far as bb can tell, so they
 * join into one stretch.
 */
export function modelStretches(turn: TimedTurn, now: number): ModelStretch[] {
  return joinModelSegments(turn, now).filter(
    // A short unexplained gap between two calls is bookkeeping, not a model request.
    (stretch) =>
      stretch.end - stretch.start >= MIN_UNEXPLAINED_MS ||
      stretch.phases.some((phase) => phase !== "model"),
  );
}

/** Unexplained gaps shorter than this are not reported as model time. */
export const MIN_UNEXPLAINED_MS = 250;

function joinModelSegments(turn: TimedTurn, now: number): ModelStretch[] {
  const stretches: ModelStretch[] = [];
  for (const segment of laneBreakdown(turn, null, now)) {
    if (!MODEL_PHASES.has(segment.phase)) continue;
    const last = stretches.at(-1);
    if (last && last.end === segment.start) {
      last.end = segment.end;
      if (!last.phases.includes(segment.phase)) last.phases.push(segment.phase);
    } else {
      stretches.push({ start: segment.start, end: segment.end, phases: [segment.phase] });
    }
  }
  return stretches;
}

const NOT_TOOL_CALLS = new Set<SpanKind>([
  "subagent",
  "waiting",
  "startup",
  "compaction",
  "error",
]);

/** A command or tool call, as opposed to a subagent, a wait, startup, compaction, or an error marker. */
export function isToolCall(span: Pick<Span, "kind">): boolean {
  return !NOT_TOOL_CALLS.has(span.kind);
}
