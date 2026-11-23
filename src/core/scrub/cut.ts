/**
 * Keeping text to a size, with a visible marker where it was cut. The `scrub`
 * functions scrub a text first (see `secrets.ts`), so a cut cannot hide a
 * secret's shape.
 */
import { head, oneLine, tail } from "../text.js";
import { scrubSecrets } from "./secrets.js";

/** Room for the marker a cut adds, so text already cut to a cap is not cut again. */
const MARKER_ROOM = 64;

/**
 * How far past a cut text is still scrubbed, so a secret that starts before
 * the cut is seen whole. Longer than any token shape above.
 */
export const SCRUB_MARGIN = 16_384;

/** The marker a cut leaves after the text it kept. The one place this format is written. */
export function endMarker(cut: number): string {
  return `\n[… ${cut} more characters cut]`;
}

/** The marker a cut leaves before the text it kept, at the start. */
export function startMarker(cut: number): string {
  return `[… ${cut} earlier characters cut]\n`;
}

/** Scrubs, then keeps the first `max` characters, with a visible marker when cut. */
export function scrub(value: string, max: number): string {
  // Only the part that can be kept, plus a margin, is worth scrubbing.
  const kept = head(value, max + SCRUB_MARGIN);
  const clean = scrubSecrets(kept, { end: kept !== value });
  if (kept === value && clean.length <= max) return clean;
  const over = Math.max(value.length, clean.length) - max;
  return `${head(clean, max)}${endMarker(over)}`;
}

/** Scrubs, then keeps the last `max` characters, with a visible marker when cut. */
export function scrubTail(value: string, max: number): string {
  const kept = tail(value, max + SCRUB_MARGIN);
  const clean = scrubSecrets(kept, { start: kept !== value });
  if (kept === value && clean.length <= max) return clean;
  const over = Math.max(value.length, clean.length) - max;
  return `${startMarker(over)}${tail(clean, max)}`;
}

/** Scrubs, then makes one line of at most `max` characters, ending in "…" when cut. */
export function scrubLine(value: string, max: number): string {
  const kept = head(value, max + SCRUB_MARGIN);
  return oneLine(scrubSecrets(kept, { end: kept !== value }), max);
}

// Must match `endMarker` and `startMarker` below.
const CUT_AT_END = /\n\[… \d+ more characters cut\]$/;
const CUT_AT_START = /^\[… \d+ earlier characters cut\]\n/;

/**
 * Scrubs text again on its way out. Text that `scrub` or `scrubTail` already
 * cut to `max` keeps its own cut and marker; anything else over `max` is cut
 * here, keeping its start or, with `keep: "end"`, its end.
 */
export function rescrub(value: string, max: number, keep: "start" | "end" = "start"): string {
  const marked = (keep === "end" ? CUT_AT_START : CUT_AT_END).test(value);
  if (value.length <= max || (marked && value.length <= max + MARKER_ROOM)) return scrubSecrets(value);
  return keep === "end" ? scrubTail(value, max) : scrub(value, max);
}

/** Text that was scrubbed already, capped. Text `scrub` cut to `max` keeps its cut and marker. */
export function recap(value: string, max: number): string {
  if (value.length <= max || (CUT_AT_END.test(value) && value.length <= max + MARKER_ROOM)) return value;
  return `${head(value, max)}${endMarker(value.length - max)}`;
}

