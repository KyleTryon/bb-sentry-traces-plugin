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

/** One line of at most `max` characters, ending in "…" when cut. */
export function oneLine(value: string, max = 90): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * A name as sent without content capture: workflow names and agent kinds are
 * written by whoever wrote the script, so only a plain identifier passes.
 */
export function identifier(value: string | null | undefined): string | null {
  const name = (value ?? "").trim();
  return /^[\w.:@/#-]{1,80}$/.test(name) ? name : null;
}
