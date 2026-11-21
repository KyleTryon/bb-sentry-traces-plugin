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

/** Quoted credential-like keys with quoted values, as in JSON, YAML or code: `"apiKey": "…"`. */
const QUOTED_PAIR = new RegExp(
  `((["'])[A-Za-z0-9_.-]*${CREDENTIAL_NAME}[A-Za-z0-9_.-]*\\2\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\3)[^\\\\\\n])+\\3`,
  "gi",
);

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** A key whose end was cut off runs to the end of the text. */
const PEM_UNTERMINATED = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/;
/** A key whose start was cut off runs from the start of the text. */
const PEM_UNSTARTED = /^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/;

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

/** Replaces secrets in free text: PEM blocks, dotenv lines, quoted pairs and known token shapes. */
export function scrubSecrets(value: string): string {
  let out = value
    .replace(PEM_BLOCK, REDACTED)
    .replace(PEM_UNTERMINATED, REDACTED)
    .replace(PEM_UNSTARTED, REDACTED);
  out = out
    .split("\n")
    .map((line) => line.replace(ENV_LINE, `$1${REDACTED}`))
    .join("\n");
  out = out.replace(QUOTED_PAIR, `$1$3${REDACTED}$3`);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** Scrubs, then keeps the first `max` characters, with a visible marker when cut. */
export function scrub(value: string, max: number): string {
  // Only the part that can be kept, plus a margin, is worth scrubbing.
  const head = value.slice(0, max + SCRUB_MARGIN);
  const clean = scrubSecrets(head);
  if (head === value && clean.length <= max) return clean;
  const over = Math.max(value.length, clean.length) - max;
  return `${clean.slice(0, Math.max(0, max))}\n[… ${over} more characters cut]`;
}

/** Scrubs, then keeps the last `max` characters, with a visible marker when cut. */
export function scrubTail(value: string, max: number): string {
  const tail = value.length > max + SCRUB_MARGIN ? value.slice(-(max + SCRUB_MARGIN)) : value;
  const clean = scrubSecrets(tail);
  if (tail === value && clean.length <= max) return clean;
  const over = Math.max(value.length, clean.length) - max;
  return `[… ${over} earlier characters cut]\n${max > 0 ? clean.slice(-max) : ""}`;
}

/** Scrubs, then makes one line of at most `max` characters, ending in "…" when cut. */
export function scrubLine(value: string, max: number): string {
  return oneLine(scrubSecrets(value.slice(0, max + SCRUB_MARGIN)), max);
}
