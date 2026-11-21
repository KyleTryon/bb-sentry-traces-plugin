/**
 * Captured content passes through here before it leaves the machine: known
 * secret shapes are replaced and the text is capped. This is a best effort,
 * not a guarantee. Content capture stays off unless the user turns it on.
 *
 * Text is scrubbed before it is cut, so a cut cannot split a secret into a
 * piece that no longer looks like one.
 */
import { oneLine } from "./util.js";

const REDACTED = "[redacted]";

/** Names of credential-like variables and fields. `AUTHOR` is not one; `AUTHORIZATION` is. */
const CREDENTIAL_NAME =
  "(?:API_?KEY|TOKEN(?!S)|SECRET|PASSWORD|PASSWD|CREDENTIAL|ACCESS_?KEY|AUTH(?!OR(?!IZ))|SESSION|COOKIE|PRIVATE_?KEY|DSN)";

/** Lines that look like dotenv assignments of credential-like variables. */
const ENV_LINE = new RegExp(
  `^(\\s*(?:export\\s+)?[A-Za-z0-9_]*${CREDENTIAL_NAME}[A-Za-z0-9_]*\\s*[=:]\\s*)\\S.*$`,
  "i",
);

/**
 * The name and `=` of a credential-like assignment anywhere in a line, as in
 * `cd app && API_KEY=… npm start` or a command inside one-line JSON.
 */
const INLINE_NAME = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?:export\s+)?[A-Za-z0-9_]*${CREDENTIAL_NAME}[A-Za-z0-9_]*=(?!=)`,
  "gi",
);
/**
 * An unquoted value: it runs to whitespace, a quote or a shell separator. A
 * backslash is part of it unless it escapes a quote or is JSON's `\n`.
 */
const UNQUOTED_VALUE = /(?:[^\s"'\\&;|]|\\(?!["'nrt]))+/y;
/** What follows a quote that closed a string: a gap, the end, or punctuation, never a value. */
const AFTER_CLOSING_QUOTE = /^(?:\s|$|\\[nrt]|[)\]},;:|&<>])/;
/** How far past its line a quoted value with no closing quote on that line is followed. */
const MAX_VALUE_LINES_CHARS = 4_096;

/**
 * Where the quote at `from` is closed before `limit`, as the index after the
 * closing quote, or -1. An escaped quote (`\"`, as inside JSON) is closed by
 * an escaped one; a plain quote by a plain one.
 */
function closingQuote(text: string, from: number, limit: number, quote: string, escaped: boolean): number {
  for (let index = from; index < limit; index++) {
    if (text[index] !== quote) continue;
    const afterBackslash = text[index - 1] === "\\" && text[index - 2] !== "\\";
    if (afterBackslash === escaped) return index + 1;
  }
  return -1;
}

/**
 * Where the value that starts at `at` ends, or `at` when there is none to
 * redact. Nothing here guesses that a secret is not one:
 *
 * - a quote closed later on the line: the value runs through that quote,
 *   whatever is between them. In `grep "KEY=" x && PASSWORD=p run "y"` that
 *   takes too much, and takes the password with it;
 * - a quote never closed on its line: a value that starts right after it runs
 *   to its closing quote on a later line, or else to the end of its line;
 * - a quote never closed with nothing after it, as in `grep 'API_KEY=' src`:
 *   that quote closed a string, and there is no value.
 */
function inlineValueEnd(text: string, at: number, lineEnd: number): number {
  const escaped = text[at] === "\\" && (text[at + 1] === '"' || text[at + 1] === "'");
  const quote = text[escaped ? at + 1 : at];
  if (quote !== '"' && quote !== "'") {
    UNQUOTED_VALUE.lastIndex = at;
    return UNQUOTED_VALUE.test(text) ? UNQUOTED_VALUE.lastIndex : at;
  }
  const open = at + (escaped ? 2 : 1);
  const closed = closingQuote(text, open, lineEnd, quote, escaped);
  if (closed !== -1) return closed;
  if (AFTER_CLOSING_QUOTE.test(text.slice(open, open + 2))) return at;
  if (escaped) {
    // Inside a JSON string that ends before the value's quote does: up to that string's end.
    const stringEnd = closingQuote(text, open, lineEnd, quote, false);
    return stringEnd !== -1 ? stringEnd - 1 : lineEnd;
  }
  const later = closingQuote(text, lineEnd, Math.min(text.length, lineEnd + MAX_VALUE_LINES_CHARS), quote, false);
  return later !== -1 ? later : lineEnd;
}

function scrubInlineAssignments(text: string): string {
  let out = "";
  let done = 0;
  let lineEnd = -1;
  INLINE_NAME.lastIndex = 0;
  for (let match = INLINE_NAME.exec(text); match; match = INLINE_NAME.exec(text)) {
    const at = match.index + match[0].length;
    if (at > lineEnd) {
      lineEnd = text.indexOf("\n", at);
      if (lineEnd === -1) lineEnd = text.length;
    }
    const end = inlineValueEnd(text, at, lineEnd);
    if (end === at) {
      // No value: go on right after any quote here, so nothing behind it is skipped.
      INLINE_NAME.lastIndex = at;
      continue;
    }
    out += text.slice(done, at) + REDACTED;
    done = end;
    INLINE_NAME.lastIndex = end;
  }
  return done === 0 ? text : out + text.slice(done);
}

/** Quoted credential-like keys with quoted values, as in JSON, YAML or code: `"apiKey": "…"`. */
const QUOTED_PAIR = new RegExp(
  `((["'])[A-Za-z0-9_.-]*${CREDENTIAL_NAME}[A-Za-z0-9_.-]*\\2\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\3)[^\\\\\\n])+\\3`,
  "gi",
);

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** In text cut short here: a key whose end was cut off runs to the end. */
const PEM_UNTERMINATED = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/;
/** In text cut short here: a key whose start was cut off runs from the start. */
const PEM_UNSTARTED = /^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/** Every key marker ends with this; text without it has no key to look for. */
const KEY_MARKER = "PRIVATE KEY-----";
const BEGIN_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g;
const END_MARKER = /-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** The header lines of an encrypted key, which sit between its marker and its body. */
const KEY_HEADER = /(?:Proc-Type|DEK-Info|Comment):[^\r\n\\]*/y;
const KEY_CHAR = /[A-Za-z0-9+/=]/;
/** A piece of key body this long is taken to be one whatever it looks like. */
const LONG_KEY_PIECE = 16;

/**
 * Whether a run of key characters is key body and not a word of the text
 * around the key. A short run is body only when it could not be a plain word:
 * it has a digit, `+`, `/` or `=`, or mixes cases past its first letter.
 */
function isKeyBody(piece: string): boolean {
  if (piece.length >= LONG_KEY_PIECE) return true;
  return /[0-9+/=]/.test(piece) || (/[a-z]/.test(piece) && /[A-Z]/.test(piece.slice(1)));
}

/** The index after any spaces, tabs and line breaks at `at`; JSON's `\n`, `\r` and `\t` count. */
function skipGap(text: string, at: number): number {
  for (;;) {
    const char = text[at];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") at++;
    else if (char === "\\" && "nrt".includes(text[at + 1] ?? "x")) at += 2;
    else return at;
  }
}

function skipGapBack(text: string, at: number): number {
  for (;;) {
    const char = text[at - 1];
    if (char === " " || char === "\t" || char === "\r" || char === "\n") at--;
    else if (at >= 2 && text[at - 2] === "\\" && "nrt".includes(char ?? "x")) at -= 2;
    else return at;
  }
}

const LINE_BREAK = /[\r\n]|\\[nr]/;

/** Whether only spaces and tabs sit between `at` and the end of its line. */
function endsLine(text: string, at: number): boolean {
  while (text[at] === " " || text[at] === "\t") at++;
  return at >= text.length || LINE_BREAK.test(text.slice(at, at + 2));
}

/** Whether only spaces and tabs sit between the start of its line and `at`. */
function startsLine(text: string, at: number): boolean {
  while (text[at - 1] === " " || text[at - 1] === "\t") at--;
  if (at === 0 || text[at - 1] === "\n" || text[at - 1] === "\r") return true;
  return text[at - 2] === "\\" && (text[at - 1] === "n" || text[at - 1] === "r");
}

/** Where the key body that follows a BEGIN marker ends, or -1 when none follows. */
function keyBodyEnd(text: string, from: number): number {
  let at = from;
  let end = -1;
  let long = false;
  let afterLong = false;
  for (;;) {
    const start = skipGap(text, at);
    if (start === at) break;
    if (end === -1) {
      KEY_HEADER.lastIndex = start;
      if (KEY_HEADER.test(text)) {
        at = KEY_HEADER.lastIndex;
        continue;
      }
    }
    let stop = start;
    while (stop < text.length && KEY_CHAR.test(text[stop])) stop++;
    const piece = text.slice(start, stop);
    // A key's last line can be short and look like a word. Alone on the line
    // right after a long line of body, it is taken to be that last line.
    const lastLine = afterLong && LINE_BREAK.test(text.slice(at, start)) && endsLine(text, stop);
    if (!piece || !(isKeyBody(piece) || lastLine)) break;
    afterLong = piece.length >= LONG_KEY_PIECE;
    long ||= afterLong;
    end = at = stop;
  }
  return long ? end : -1;
}

/** Where the key body that leads up to an END marker starts, or -1 when none does. */
function keyBodyStart(text: string, to: number): number {
  let at = to;
  let start = -1;
  let long = false;
  let nearest = true;
  for (;;) {
    const stop = skipGapBack(text, at);
    if (stop === at) break;
    let first = stop;
    while (first > 0 && KEY_CHAR.test(text[first - 1])) first--;
    // The `n` of a JSON `\n` is a line break, not the piece's first character.
    if (first > 0 && first < stop && text[first - 1] === "\\" && "nrt".includes(text[first])) first++;
    const piece = text.slice(first, stop);
    // The line just before the marker is the key's last line, short or not.
    const lastLine = nearest && LINE_BREAK.test(text.slice(stop, at)) && startsLine(text, first);
    if (!piece || !(isKeyBody(piece) || lastLine)) break;
    nearest = false;
    long ||= piece.length >= LONG_KEY_PIECE;
    start = at = first;
  }
  return long ? start : -1;
}

/**
 * Redacts keys with one marker missing: cut off by a tool or by bb before the
 * text got here. A lone marker is such a key only when key body sits next to
 * it. The marker and the body are redacted, and the text around them is kept;
 * code or prose that only mentions a marker keeps all its text.
 */
function scrubCutOffKeys(text: string): string {
  const ranges: Array<[number, number]> = [];
  for (const marker of text.matchAll(BEGIN_MARKER)) {
    const end = keyBodyEnd(text, marker.index + marker[0].length);
    if (end !== -1) ranges.push([marker.index, end]);
  }
  for (const marker of text.matchAll(END_MARKER)) {
    const start = keyBodyStart(text, marker.index);
    if (start !== -1) ranges.push([start, marker.index + marker[0].length]);
  }
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end] of ranges) {
    if (end <= at) continue;
    // A range that starts inside the last one only makes it longer.
    if (start >= at) out += text.slice(at, start) + REDACTED;
    at = end;
  }
  return out + text.slice(at);
}

/** Where a text was cut before it reached the scrubber. */
export interface Cut {
  start?: boolean;
  end?: boolean;
}

/** Room for the marker a cut adds, so text already cut to a cap is not cut again. */
const MARKER_ROOM = 64;

/** Known token shapes; each hit is replaced wholesale. */
const TOKEN_PATTERNS: RegExp[] = [
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // GitHub fine-grained tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, // OpenAI and Anthropic keys
  /\bsntry[su]_[A-Za-z0-9_=-]{20,}/g, // Sentry auth tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWTs
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // bearer headers
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi, // credentials inside a URL
  /\bhttps?:\/\/[0-9a-f]{32}@[^\s/]+\/\d+/gi, // Sentry DSNs
];

/**
 * How far past a cut text is still scrubbed, so a secret that starts before
 * the cut is seen whole. Longer than any token shape above.
 */
const SCRUB_MARGIN = 16_384;

/**
 * Replaces secrets in free text: PEM blocks, dotenv lines, inline assignments,
 * quoted pairs and known token shapes. `cut` says which ends were cut off, where
 * a lone key marker is taken to be a key that runs on past the cut.
 */
export function scrubSecrets(value: string, cut: Cut = {}): string {
  let out = value;
  if (out.includes(KEY_MARKER)) {
    out = out.replace(PEM_BLOCK, REDACTED);
    if (cut.end) out = out.replace(PEM_UNTERMINATED, REDACTED);
    if (cut.start) out = out.replace(PEM_UNSTARTED, REDACTED);
    out = scrubCutOffKeys(out);
  }
  out = out
    .split("\n")
    .map((line) => line.replace(ENV_LINE, `$1${REDACTED}`))
    .join("\n");
  out = scrubInlineAssignments(out);
  out = out.replace(QUOTED_PAIR, `$1$3${REDACTED}$3`);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Scrubs, then keeps the first `max` characters, with a visible marker when cut. */
export function scrub(value: string, max: number): string {
  // Only the part that can be kept, plus a margin, is worth scrubbing.
  const head = value.slice(0, max + SCRUB_MARGIN);
  const clean = scrubSecrets(head, { end: head !== value });
  if (head === value && clean.length <= max) return clean;
  const over = Math.max(value.length, clean.length) - max;
  return `${clean.slice(0, Math.max(0, max))}\n[… ${over} more characters cut]`;
}

/** Scrubs, then keeps the last `max` characters, with a visible marker when cut. */
export function scrubTail(value: string, max: number): string {
  const tail = value.length > max + SCRUB_MARGIN ? value.slice(-(max + SCRUB_MARGIN)) : value;
  const clean = scrubSecrets(tail, { start: tail !== value });
  if (tail === value && clean.length <= max) return clean;
  const over = Math.max(value.length, clean.length) - max;
  return `[… ${over} earlier characters cut]\n${max > 0 ? clean.slice(-max) : ""}`;
}

/** Scrubs, then makes one line of at most `max` characters, ending in "…" when cut. */
export function scrubLine(value: string, max: number): string {
  const head = value.slice(0, max + SCRUB_MARGIN);
  return oneLine(scrubSecrets(head, { end: head !== value }), max);
}

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
