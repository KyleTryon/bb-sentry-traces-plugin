/**
 * Scrubbing structured values: a tool's arguments or result, or a provider's
 * message content that may be JSON. Strings are scrubbed one by one, so a
 * credential-named field is redacted even when its value is not a known shape.
 */
import { endMarker, SCRUB_MARGIN, scrub } from "./cut.js";
import { CREDENTIAL_KEY, REDACTED, scrubSecrets } from "./secrets.js";

const MAX_DEPTH = 64;

/**
 * A copy of a structured value with every string in it scrubbed on its own.
 * `room` is how many characters of strings are still worth scrubbing: past
 * it, everything is cut off anyway and is left out.
 */
function scrubStrings(value: unknown, room: { left: number }, depth = 0): unknown {
  if (typeof value === "string") {
    if (room.left <= 0) return "";
    const head = value.slice(0, room.left);
    room.left -= head.length;
    return scrubSecrets(head, { end: head !== value });
  }
  if (value === null || typeof value !== "object") return value;
  // Too deep to walk: scrubbed as the text it would become.
  if (depth >= MAX_DEPTH) return scrubStrings(JSON.stringify(value) ?? "", room, depth);
  if (Array.isArray(value)) return value.map((item) => scrubStrings(item, room, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] =
      typeof item === "string" && item && CREDENTIAL_KEY.test(key)
        ? REDACTED
        : scrubStrings(item, room, depth + 1);
  }
  return copy;
}

/**
 * Scrubs a value a tool was called with or returned, then caps it like
 * `scrub`. Text is scrubbed as text. Anything structured has each of its
 * strings scrubbed before it is written as JSON: in the JSON, the quotes of
 * the format and the quotes inside a command cannot be told apart.
 */
export function scrubValue(value: unknown, max: number): string {
  if (typeof value === "string") return scrub(value, max);
  if (value === undefined || value === null) return "";
  let full: string | undefined;
  let clean: string | undefined;
  try {
    full = JSON.stringify(value);
    clean = JSON.stringify(scrubStrings(value, { left: max + SCRUB_MARGIN }));
  } catch {
    return "";
  }
  if (full === undefined || clean === undefined) return "";
  if (full.length <= max && clean.length <= max) return clean;
  const over = Math.max(full.length, clean.length) - max;
  return `${clean.slice(0, Math.max(0, max))}${endMarker(over)}`;
}

/** Scrubs text that may itself be JSON, as a provider's message content is: then as `scrubValue` does. */
export function scrubText(value: string, max: number): string {
  const first = value.trimStart()[0];
  if (first === "{" || first === "[") {
    try {
      return scrubValue(JSON.parse(value), max);
    } catch {
      // Not JSON after all.
    }
  }
  return scrub(value, max);
}

