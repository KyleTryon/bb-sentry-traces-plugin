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
 * Credential-like assignments anywhere in a line, as in `cd app && API_KEY=… npm
 * start` or a command inside one-line JSON. A quoted value (escaped quotes
 * too, as inside JSON) runs to its closing quote, or to the end of the line
 * when it has none. An unquoted value runs to whitespace, a quote or a shell
 * separator; a backslash in it is part of it unless it escapes a quote or is
 * JSON's `\n`.
 */
const INLINE_ASSIGNMENT = new RegExp(
  String.raw`((?<![A-Za-z0-9_])(?:export\s+)?[A-Za-z0-9_]*${CREDENTIAL_NAME}[A-Za-z0-9_]*=)(?!=)` +
    "(?:" +
    [
      String.raw`\\?"[^"\n]*?\\?"`,
      String.raw`\\?'[^'\n]*?\\?'`,
      String.raw`\\?["'][^\n]*`,
      String.raw`(?:[^\s"'\\&;|]|\\(?!["'nrt]))+`,
    ].join("|") +
    ")",
  "gi",
);

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
/*
 * In any other text, a lone marker is a key cut off elsewhere (by a tool, by
 * bb) only when key body sits next to it: the marker and the body lines are
 * redacted, through the last body line, and whatever follows them is kept.
 * Code or prose that only mentions a marker keeps all its text. Lines break
 * on real newlines or on JSON's `\n`, and encrypted keys' header lines count
 * as body.
 */
const PEM_LINE_BREAK = String.raw`(?:\r?\n|(?:\\r)?\\n)`;
const PEM_HEADER = String.raw`(?:Proc-Type|DEK-Info|Comment):[^\r\n\\]*`;
const PEM_LONG_LINE = String.raw`[A-Za-z0-9+/=]{16,}(?![A-Za-z0-9+/=])`;
const PEM_ANY_LINE = String.raw`[A-Za-z0-9+/=]+(?![A-Za-z0-9+/=])`;
const PEM_BODY_AFTER_BEGIN = new RegExp(
  String.raw`-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[ \t]*` +
    String.raw`(?:${PEM_LINE_BREAK}[ \t]*(?:${PEM_HEADER})?)*?` +
    String.raw`${PEM_LINE_BREAK}[ \t]*${PEM_LONG_LINE}` +
    String.raw`(?:${PEM_LINE_BREAK}[ \t]*${PEM_ANY_LINE})*`,
  "g",
);
const PEM_BODY_BEFORE_END = new RegExp(
  String.raw`(?<![A-Za-z0-9+/=])${PEM_LONG_LINE}[ \t]*` +
    String.raw`(?:${PEM_LINE_BREAK}[ \t]*${PEM_ANY_LINE}[ \t]*)*` +
    String.raw`${PEM_LINE_BREAK}[ \t]*-----END [A-Z0-9 ]*PRIVATE KEY-----`,
  "g",
);

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
  let out = value.replace(PEM_BLOCK, REDACTED);
  if (cut.end) out = out.replace(PEM_UNTERMINATED, REDACTED);
  if (cut.start) out = out.replace(PEM_UNSTARTED, REDACTED);
  out = out.replace(PEM_BODY_AFTER_BEGIN, REDACTED).replace(PEM_BODY_BEFORE_END, REDACTED);
  out = out
    .split("\n")
    .map((line) => line.replace(ENV_LINE, `$1${REDACTED}`))
    .join("\n");
  out = out.replace(INLINE_ASSIGNMENT, `$1${REDACTED}`);
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
