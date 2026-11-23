/**
 * Small helpers for reading untyped event data, and for checking names that are
 * safe to send without content capture.
 *
 * Adapted from bb-plugin-agent-traces (https://github.com/charpeni/bb-plugins,
 * plugins/agent-traces/util.ts), MIT License, Copyright (c) 2026 Nicolas
 * Charpentier. See THIRD_PARTY_NOTICES.md.
 */

export type Json = Record<string, unknown>;

export function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The first `max` UTF-16 units of `value`, one fewer when the cut would split
 * an emoji or another character outside the BMP: half of one is not valid
 * Unicode, and Sentry may refuse the request that carries it.
 */
export function head(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return "";
  return value.slice(0, isHighSurrogate(value.charCodeAt(max - 1)) ? max - 1 : max);
}

/** The last `max` UTF-16 units of `value`, one fewer when the cut would split a character. */
export function tail(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 0) return "";
  const start = value.length - max;
  return value.slice(isLowSurrogate(value.charCodeAt(start)) ? start + 1 : start);
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** `value` with any half of a split character replaced by U+FFFD, so it is valid Unicode. */
export function wellFormed(value: string): string {
  return value.replace(LONE_SURROGATE, "�");
}

/** One line of at most `max` characters, ending in "…" when cut. */
export function oneLine(value: string, max = 90): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${head(line, max - 1)}…` : line;
}

/**
 * A name as sent without content capture: workflow names and agent kinds are
 * written by whoever wrote the script, so only a plain identifier passes. A
 * `/` is refused, so a path cannot pass for a name.
 */
export function identifier(value: string | null | undefined): string | null {
  const name = (value ?? "").trim();
  return /^[\w.:@#-]{1,80}$/.test(name) ? name : null;
}

/**
 * A tool's name as sent without content capture: `shell`, `Read`,
 * `mcp__docs__search`. Tool names come from providers and MCP servers, which
 * could put anything in one, so only a plain identifier passes: no `/`, no
 * spaces, and not long.
 */
export function toolName(value: string | null | undefined): string | null {
  const name = (value ?? "").trim();
  return /^[\w.:@-]{1,80}$/.test(name) ? name : null;
}

/**
 * An error message as sent without content capture: only one that reads as a
 * code, such as `overloaded_error`, `rate_limit_error` or `manual-stop`. Any
 * other message may hold a path, a command line or a credential, so it is
 * content.
 */
export function errorCode(value: string | null | undefined): string | null {
  const code = (value ?? "").trim();
  return /^[A-Za-z][\w.-]{0,63}$/.test(code) ? code : null;
}
