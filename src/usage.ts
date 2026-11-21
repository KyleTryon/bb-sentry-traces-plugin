/**
 * Token usage. bb keeps one running total per thread, so a turn's usage is the
 * difference between the total now and the total at the last export.
 *
 * Sentry wants `input_tokens` to include cached tokens and `output_tokens` to
 * include reasoning tokens. Providers disagree on both (Claude Code reports
 * input without its cache reads and writes; Codex includes them), so the
 * convention is read off the numbers themselves: `totalTokens` says which
 * parts were already counted.
 */
import { record, type Json } from "./util.js";

/** bb's `tokenUsage.total` (or `.last`), as stored. */
export interface RawUsage {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  outputTokens: number;
  reasoningOutputTokens: number;
}

/** Usage in Sentry's convention: the cache and reasoning counts are subsets. */
export interface SentryUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reads `tokenUsage.total` from a `thread/tokenUsage/updated` event's data. */
export function readTotal(data: unknown): RawUsage | null {
  const total = record(record(record(data).tokenUsage).total);
  return parseRawUsage(total);
}

export function parseRawUsage(value: Json): RawUsage | null {
  const inputTokens = count(value.inputTokens);
  const outputTokens = count(value.outputTokens);
  if (inputTokens === null || outputTokens === null) return null;
  const cachedInputTokens = count(value.cachedInputTokens) ?? 0;
  return {
    totalTokens: count(value.totalTokens) ?? 0,
    inputTokens,
    cachedInputTokens,
    cacheReadInputTokens: count(value.cacheReadInputTokens),
    cacheWriteInputTokens: count(value.cacheWriteInputTokens),
    outputTokens,
    reasoningOutputTokens: count(value.reasoningOutputTokens) ?? 0,
  };
}

/**
 * What was used between two totals. Null when the total went backwards (the
 * provider started a new count), since then the difference means nothing.
 */
export function usageDelta(current: RawUsage, previous: RawUsage | null): RawUsage | null {
  if (!previous) return current;
  const sub = (a: number, b: number) => a - b;
  // A split the earlier total did not have is unknown for this stretch, not all new.
  const optional = (a: number | null, b: number | null) =>
    a === null || b === null ? null : sub(a, b);
  const delta: RawUsage = {
    totalTokens: sub(current.totalTokens, previous.totalTokens),
    inputTokens: sub(current.inputTokens, previous.inputTokens),
    cachedInputTokens: sub(current.cachedInputTokens, previous.cachedInputTokens),
    cacheReadInputTokens: optional(current.cacheReadInputTokens, previous.cacheReadInputTokens),
    cacheWriteInputTokens: optional(current.cacheWriteInputTokens, previous.cacheWriteInputTokens),
    outputTokens: sub(current.outputTokens, previous.outputTokens),
    reasoningOutputTokens: sub(current.reasoningOutputTokens, previous.reasoningOutputTokens),
  };
  const values = Object.values(delta).filter((value): value is number => value !== null);
  return values.some((value) => value < 0) ? null : delta;
}

export function isEmptyUsage(usage: RawUsage): boolean {
  return usage.inputTokens + usage.cachedInputTokens + usage.outputTokens === 0;
}

/** Converts bb's counts to Sentry's convention. */
export function toSentryUsage(raw: RawUsage): SentryUsage {
  const { inputTokens: input, cachedInputTokens: cached, outputTokens: output } = raw;
  const reasoning = raw.reasoningOutputTokens;
  const total = raw.totalTokens;

  // Which parts does `total` already count? Try each convention against it.
  let inputExcludesCached: boolean;
  let outputExcludesReasoning = false;
  if (cached > 0 && total === input + cached + output) {
    inputExcludesCached = true;
  } else if (total === input + output) {
    inputExcludesCached = false;
  } else if (cached > 0 && reasoning > 0 && total === input + cached + output + reasoning) {
    inputExcludesCached = true;
    outputExcludesReasoning = true;
  } else if (reasoning > 0 && total === input + output + reasoning) {
    inputExcludesCached = false;
    outputExcludesReasoning = true;
  } else {
    // No total to go by: cached tokens cannot exceed an input that includes them.
    inputExcludesCached = cached > input;
  }

  const inputTokens = input + (inputExcludesCached ? cached : 0);
  const outputTokens = output + (outputExcludesReasoning ? reasoning : 0);
  const cacheWriteTokens = raw.cacheWriteInputTokens ?? 0;
  // Without a read/write split, bb's cached count is all reads.
  const cacheReadTokens = raw.cacheReadInputTokens ?? Math.max(0, cached - cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: Math.min(cacheReadTokens, inputTokens),
    cacheWriteTokens: Math.min(cacheWriteTokens, inputTokens),
    reasoningTokens: Math.min(reasoning, outputTokens),
  };
}

/** The span attributes for a usage, in Sentry's names. */
export function usageAttributes(usage: SentryUsage): Record<string, number | undefined> {
  return {
    "gen_ai.usage.input_tokens": usage.inputTokens,
    "gen_ai.usage.output_tokens": usage.outputTokens,
    "gen_ai.usage.total_tokens": usage.totalTokens,
    "gen_ai.usage.cache_read.input_tokens": usage.cacheReadTokens || undefined,
    "gen_ai.usage.cache_creation.input_tokens": usage.cacheWriteTokens || undefined,
    "gen_ai.usage.reasoning.output_tokens": usage.reasoningTokens || undefined,
  };
}
