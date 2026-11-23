/**
 * Token usage. bb keeps one running total per thread, so a turn's usage is the
 * difference between the total now and the total at the last export.
 *
 * Sentry wants `input_tokens` to include cached tokens and `output_tokens` to
 * include reasoning tokens. Providers disagree on both (Claude Code reports
 * input without its cache reads and writes; Codex includes them), so the
 * convention comes from what cannot be otherwise (a cache larger than the
 * input), then from the bb provider where its convention is known, then from
 * the numbers themselves: `totalTokens` says which parts were already counted.
 *
 * ACP agents report no tokens at all, but some (OpenCode) report a running
 * cost in USD with their context window usage; Sentry takes that as
 * `gen_ai.cost.total_tokens`.
 */
import { record, text, type Json } from "./text.js";

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
  const total = record(record(record(data)['tokenUsage'])['total']);
  return parseRawUsage(total);
}

export function parseRawUsage(value: Json): RawUsage | null {
  const inputTokens = count(value['inputTokens']);
  const outputTokens = count(value['outputTokens']);
  if (inputTokens === null || outputTokens === null) return null;
  const cachedInputTokens = count(value['cachedInputTokens']) ?? 0;
  return {
    totalTokens: count(value['totalTokens']) ?? 0,
    inputTokens,
    cachedInputTokens,
    cacheReadInputTokens: count(value['cacheReadInputTokens']),
    cacheWriteInputTokens: count(value['cacheWriteInputTokens']),
    outputTokens,
    reasoningOutputTokens: count(value['reasoningOutputTokens']) ?? 0,
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

/**
 * How bb's providers count input, where it is known: Claude Code reports its
 * input without cache reads and writes, Codex with them.
 */
const INPUT_EXCLUDES_CACHE: Readonly<Record<string, boolean>> = {
  "claude-code": true,
  codex: false,
};

/**
 * Whether the input leaves its cached tokens out, when that is settled
 * before looking at `totalTokens`: a cache larger than the input cannot be
 * part of it, whatever else the numbers say; else the bb provider decides
 * when its convention is known. Null when neither says.
 */
function settledInputConvention(raw: RawUsage, providerId: string | null | undefined): boolean | null {
  if (cacheOf(raw) > raw.inputTokens) return true;
  return (providerId ? INPUT_EXCLUDES_CACHE[providerId] : undefined) ?? null;
}

/**
 * All cached input: bb's cached count, or its reads and writes together when
 * they add up to more (a provider that fills in only the split).
 */
function cacheOf(raw: RawUsage): number {
  const split = (raw.cacheReadInputTokens ?? 0) + (raw.cacheWriteInputTokens ?? 0);
  return Math.max(raw.cachedInputTokens, split);
}

/** Each way of counting: [input leaves out its cache, output leaves out its reasoning]. */
const CONVENTIONS: readonly (readonly [boolean, boolean])[] = [
  [true, false],
  [false, false],
  [true, true],
  [false, true],
];

/**
 * Converts bb's counts to Sentry's convention. `providerId` is the thread's
 * bb provider, when known; it settles how the input was counted.
 */
export function toSentryUsage(raw: RawUsage, providerId?: string | null): SentryUsage {
  const { inputTokens: input, outputTokens: output } = raw;
  const cached = cacheOf(raw);
  const reasoning = raw.reasoningOutputTokens;
  const total = raw.totalTokens;

  // Which parts does `total` already count? Try each convention against it,
  // keeping to the input convention when that is already settled. With
  // nothing to go by, the input includes its cache, as Sentry's does.
  const settled = settledInputConvention(raw, providerId);
  const match = CONVENTIONS.find(
    ([excludesCached, excludesReasoning]) =>
      (settled === null || settled === excludesCached) &&
      (!excludesCached || cached > 0) &&
      (!excludesReasoning || reasoning > 0) &&
      total === input + (excludesCached ? cached : 0) + output + (excludesReasoning ? reasoning : 0),
  );
  const inputExcludesCached = settled ?? match?.[0] ?? false;
  const outputExcludesReasoning = match?.[1] ?? false;

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

/**
 * The running cost in USD that a `thread/contextWindowUsage/updated` event's
 * data reports, as ACP agents such as OpenCode do. Null when there is none,
 * or when it is in another currency: Sentry takes costs in USD only.
 */
export function readCost(data: unknown): number | null {
  const cost = record(record(record(data)['contextWindowUsage'])['cost']);
  if (text(cost['currency']).toUpperCase() !== "USD") return null;
  return count(cost['amount']);
}

/**
 * The cost between two running costs. Null when it went backwards (the agent
 * started a new session), since then the difference means nothing.
 */
export function costDelta(current: number, previous: number | null): number | null {
  if (previous === null) return current;
  return current >= previous ? current - previous : null;
}

/**
 * A provider's own cost, in Sentry's name. Sentry keeps a numeric
 * `gen_ai.cost.total_tokens` instead of estimating one from tokens
 * (https://docs.sentry.io/product/agents/costs/#send-custom-costs), so it is
 * only sent where there are no tokens to estimate from.
 */
export function costAttributes(costUsd: number): Record<string, number> {
  return { "gen_ai.cost.total_tokens": costUsd };
}
