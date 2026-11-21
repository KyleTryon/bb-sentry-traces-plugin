/**
 * Captured content passes through here before it leaves the machine: known
 * secret shapes are replaced, then the text is capped (`cut.ts`). This is a
 * best effort, not a guarantee. Content capture stays off unless the user turns
 * it on. Structured values are scrubbed string by string in `value.ts`.
 *
 * Text is scrubbed before it is cut, so a cut cannot split a secret into a
 * piece that no longer looks like one.
 */
export const REDACTED = "[redacted]";

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
 * `cd app && API_KEY=… npm start`.
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
/** How far past its line a quoted value with no closing quote on that line is followed. */
const MAX_VALUE_LINES_CHARS = 4_096;

/** Whether the character at `index` is a quote of the kind asked for: escaped (`\"`) or plain. */
function isQuote(text: string, index: number, quote: string, escaped: boolean): boolean {
  if (text[index] !== quote) return false;
  return (text[index - 1] === "\\" && text[index - 2] !== "\\") === escaped;
}

/** Where every quote of one kind sits on one line. Built once per line and kind. */
class LineQuotes {
  private readonly found = new Map<string, number[]>();

  constructor(
    private readonly text: string,
    private readonly start: number,
    readonly end: number,
  ) {}

  /** The quotes of this kind from `from` to the end of the line. */
  after(from: number, quote: string, escaped: boolean): number[] {
    const kind = `${escaped ? "\\" : ""}${quote}`;
    let all = this.found.get(kind);
    if (!all) {
      all = [];
      for (let index = this.start; index < this.end; index++) {
        if (isQuote(this.text, index, quote, escaped)) all.push(index);
      }
      this.found.set(kind, all);
    }
    let low = 0;
    let high = all.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (all[middle] < from) low = middle + 1;
      else high = middle;
    }
    return low === 0 ? all : all.slice(low);
  }
}

/**
 * Where the value that starts at `at` ends, or `at` when there is none.
 *
 * A quote right after the `=` may open a value (`TOKEN="a b"`) or close a
 * string that ends in the name (`grep 'API_KEY=' src`), and nothing in the
 * text says which for certain. So a doubt redacts, by how many more quotes of
 * its kind the line has:
 *
 * - an odd number: the next one closes the value, unless another credential
 *   name sits before it, and then the rest of the line goes;
 * - an even number: the quotes do not pair up from here, and the rest of the
 *   line goes;
 * - none: the value runs to its closing quote on a later line, or else to the
 *   end of its line.
 */
function inlineValueEnd(text: string, at: number, line: LineQuotes): number {
  const escaped = text[at] === "\\" && (text[at + 1] === '"' || text[at + 1] === "'");
  const quote = text[escaped ? at + 1 : at];
  if (quote !== '"' && quote !== "'") {
    UNQUOTED_VALUE.lastIndex = at;
    return UNQUOTED_VALUE.test(text) ? UNQUOTED_VALUE.lastIndex : at;
  }
  const open = at + (escaped ? 2 : 1);
  const more = line.after(open, quote, escaped);
  if (more.length === 0) {
    const limit = Math.min(text.length, line.end + MAX_VALUE_LINES_CHARS);
    for (let index = line.end; index < limit; index++) {
      if (isQuote(text, index, quote, escaped)) return index + 1;
    }
    return line.end;
  }
  if (more.length % 2 === 0) return line.end;
  INLINE_NAME.lastIndex = open;
  const next = INLINE_NAME.exec(text);
  return next && next.index < more[0] ? line.end : more[0] + 1;
}

function scrubInlineAssignments(text: string): string {
  let out = "";
  let done = 0;
  let line = new LineQuotes(text, 0, -1);
  let from = 0;
  for (;;) {
    INLINE_NAME.lastIndex = from;
    const match = INLINE_NAME.exec(text);
    if (!match) break;
    const at = match.index + match[0].length;
    if (at > line.end) {
      const end = text.indexOf("\n", at);
      line = new LineQuotes(text, text.lastIndexOf("\n", at - 1) + 1, end === -1 ? text.length : end);
    }
    const end = inlineValueEnd(text, at, line);
    if (end > at) {
      out += text.slice(done, at) + REDACTED;
      done = end;
    }
    from = Math.max(end, at);
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
/** A line break, or the quote that closes a string the key sits at the end of. */
const LINE_END = /^(?:[\r\n"]|\\[nr"])/;

/** Whether only spaces and tabs sit between `at` and the end of its line. */
function endsLine(text: string, at: number): boolean {
  while (text[at] === " " || text[at] === "\t") at++;
  return at >= text.length || LINE_END.test(text.slice(at, at + 2));
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
  // Inline assignments first: a quoted value can run over several lines, and
  // the line-by-line pass after it would only see its first.
  out = scrubInlineAssignments(out);
  out = out
    .split("\n")
    .map((line) => line.replace(ENV_LINE, `$1${REDACTED}`))
    .join("\n");
  out = out.replace(QUOTED_PAIR, `$1$3${REDACTED}$3`);
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** A field named like a credential, as in `{"apiKey": "…"}`. */
export const CREDENTIAL_KEY = new RegExp(`^[A-Za-z0-9_.-]*${CREDENTIAL_NAME}[A-Za-z0-9_.-]*$`, "i");

