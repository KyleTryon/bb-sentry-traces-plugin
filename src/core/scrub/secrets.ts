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

/**
 * Names ending in `_KEY` that are not credentials: database, cache and map
 * keys and the like. `PRIMARY_KEY=id` is code, `STRIPE_KEY=…` is not.
 */
const PLAIN_KEY_NAME =
  "(?:PRIMARY|FOREIGN|SORT|PARTITION|CACHE|IDEMPOTENCY|ROUTING|PUBLIC|PUB|HASH|RANGE|LOOKUP|GROUP|MAP|ROW|DEDUPE?|UNIQUE|OBJECT|S3|I18N|TRANSLATION|STORAGE|SHORTCUT|HOT|SEARCH|INDEX|SHARD|BUCKET|FIELD|ITEM|ENTRY|STATE|LABEL|MESSAGE|LOCALE|COLUMN|TABLE|EVENT|METRIC|TAG|QUERY|LIST|SECTION|REACT|SSH_PUBLIC)";

/**
 * Names of credential-like variables and fields. `AUTHOR` is not one;
 * `AUTHORIZATION` is. The short words `PASS`, `PWD` and `KEY` count only as a
 * whole part of a name (`DB_PASS`, `MYSQL_PWD`, `SIGNING_KEY`, `api-key`), so
 * `passport`, `monkey` and a plain `key` are left alone.
 */
const CREDENTIAL_NAME =
  "(?:API[_-]?KEY|TOKEN(?!S)|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|ACCESS[_-]?KEY|ACCOUNT[_-]?KEY" +
  "|AUTH(?!OR(?!IZ))|SESSION|COOKIE|PRIVATE[_-]?KEY|DSN" +
  "|(?<![A-Za-z0-9])(?:PASS|PWD)(?![A-Za-z0-9])" +
  `|(?<=[A-Za-z0-9])(?<!${PLAIN_KEY_NAME})[_-]KEY(?![A-Za-z0-9]))`;
/**
 * The rest of a name around a credential word. Bounded, so a long run of
 * name characters cannot make a match try every split of it.
 */
const NAME_PART = "[A-Za-z0-9_-]{0,64}";

/** Lines that look like dotenv assignments of credential-like variables. */
const ENV_LINE = new RegExp(
  `^(\\s*(?:export\\s+)?${NAME_PART}${CREDENTIAL_NAME}${NAME_PART}\\s*[=:]\\s*)\\S.*$`,
  "i",
);

/**
 * The name and `=` of a credential-like assignment anywhere in a line, as in
 * `cd app && API_KEY=… npm start`.
 */
const INLINE_NAME = new RegExp(
  String.raw`(?<![A-Za-z0-9_])(?:export\s+)?${NAME_PART}${CREDENTIAL_NAME}${NAME_PART}=(?!=)`,
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
      const quoteAt = all[middle];
      if (quoteAt !== undefined && quoteAt < from) low = middle + 1;
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
  const first = more[0];
  if (first === undefined) {
    const limit = Math.min(text.length, line.end + MAX_VALUE_LINES_CHARS);
    for (let index = line.end; index < limit; index++) {
      if (isQuote(text, index, quote, escaped)) return index + 1;
    }
    return line.end;
  }
  if (more.length % 2 === 0) return line.end;
  INLINE_NAME.lastIndex = open;
  const next = INLINE_NAME.exec(text);
  return next && next.index < first ? line.end : first + 1;
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
  `((["'])[A-Za-z0-9_.-]{0,64}${CREDENTIAL_NAME}[A-Za-z0-9_.-]{0,64}\\2\\s*[:=]\\s*)(["'])(?:\\\\.|(?!\\3)[^\\\\\\n])+\\3`,
  "gi",
);

/**
 * What a private key marker says after BEGIN or END: `RSA PRIVATE KEY`, or
 * `PGP PRIVATE KEY BLOCK` for a PGP key. Its kind is bounded, so a run of
 * spaces cannot make every match attempt walk it.
 */
const MARKER_NAME = "[A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----";
/** In text cut short here: a key whose end was cut off runs to the end. */
const PEM_UNTERMINATED = new RegExp(`-----BEGIN ${MARKER_NAME}[\\s\\S]*$`);
/** In text cut short here: a key whose start was cut off runs from the start. */
const PEM_UNSTARTED = new RegExp(`^[\\s\\S]*?-----END ${MARKER_NAME}`);

/** Every key marker has this; text without it has no key to look for. */
const KEY_MARKER = "PRIVATE KEY";
const BEGIN_MARKER = new RegExp(`-----BEGIN ${MARKER_NAME}`, "g");
const END_MARKER = new RegExp(`-----END ${MARKER_NAME}`, "g");
/** The header lines of an encrypted or PGP key, which sit between its marker and its body. */
const KEY_HEADER = /(?:Proc-Type|DEK-Info|Comment|Version|Hash|Charset):[^\r\n\\]*/y;
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
    while (stop < text.length && KEY_CHAR.test(text.charAt(stop))) stop++;
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
    while (first > 0 && KEY_CHAR.test(text.charAt(first - 1))) first--;
    // The `n` of a JSON `\n` is a line break, not the piece's first character.
    if (first > 0 && first < stop && text[first - 1] === "\\" && "nrt".includes(text.charAt(first)))
      first++;
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

/**
 * Replaces whole keys, BEGIN marker to END marker. Done by hand, not with one
 * lazy pattern: that would walk to the end of the text from every BEGIN that
 * has no END after it.
 */
function scrubWholeKeys(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    BEGIN_MARKER.lastIndex = at;
    const begin = BEGIN_MARKER.exec(text);
    if (!begin) break;
    END_MARKER.lastIndex = begin.index + begin[0].length;
    const end = END_MARKER.exec(text);
    // No END after this BEGIN means none after any later BEGIN either.
    if (!end) break;
    out += text.slice(at, begin.index) + REDACTED;
    at = end.index + end[0].length;
  }
  // `matchAll` starts where these were left.
  BEGIN_MARKER.lastIndex = 0;
  END_MARKER.lastIndex = 0;
  return at === 0 ? text : out + text.slice(at);
}

/**
 * Credentials in a URL, as in `postgres://user:pass@host`. The user may be
 * empty (`redis://:pass@host`), and the password may hold `/` or `@`: an `@`
 * belongs to it while another `@` follows before any `/`. A port is not a
 * password, so `http://localhost:3000/@vite/client` is left alone, and a
 * quote ends the URL, so it cannot run on into the next JSON field. Every part
 * is bounded, so no input makes it slow; the scheme has no `\b` before it, so
 * a scheme glued to the word before it is still found.
 */
const URL_CREDENTIALS =
  /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@"'`<>]{0,256}:(?!\d{1,5}(?:[/?#]|$))(?:[^\s@"'`<>]|@(?=[^\s@/"'`<>]{0,256}@)){1,256}@/gi;

/** `Basic` and what may be base64 of `user:password`, anywhere in a line. */
const BASIC_CREDENTIALS = /\bBasic\s+([A-Za-z0-9+/]{4,4096}={0,2})(?![A-Za-z0-9+/=])/g;

/**
 * Whether text after `Basic` is HTTP basic credentials: base64 of
 * `user:password`. Decoding it tells credentials from a word, as in
 * `Basic information`, which no pattern could.
 */
function isBasicCredential(encoded: string): boolean {
  try {
    // Printable text with a colon in it; a word decodes to binary.
    const decoded = atob(encoded);
    return decoded.includes(":") && /^[\x20-\x7e\u0080-ÿ]+$/.test(decoded);
  } catch {
    return false;
  }
}

/**
 * Credentials in HTTP headers anywhere in a line, as in `curl -H "…"`: the
 * value of an `Authorization` header (its scheme stays), of a header named
 * like a key or token, and of a cookie header.
 */
const AUTH_HEADER = /(\b(?:Proxy-)?Authorization\s{0,8}:\s{0,8})((?:[A-Za-z][\w-]{0,20}\s+)?)[^\s"'\\]{1,4096}/gi;
const NAMED_KEY_HEADER =
  /(\b(?:X-[A-Za-z0-9-]{0,32}(?:Key|Token|Secret|Auth|Signature)|Api-Key)\s{0,8}:\s{0,8})[^\s"'\\]{1,4096}/gi;
const COOKIE_HEADER = /(\b(?:Set-)?Cookie\s{0,8}:\s{0,8})[^\s"'\\][^"'\r\n\\]{0,4095}/gi;

/** Passwords given as command flags: `curl -u user:pass` and `mysql -ppass`. */
const CURL_USER = /(\bcurl\b[^\n|;&]{0,256}?\s(?:-u|--user)(?:\s{1,8}|=)?["']?)[^\s"':]{0,256}:[^\s"']{1,4096}/g;
const MYSQL_PASSWORD = /(\bmysql(?:dump|admin|sh|import)?\b[^\n|;&]{0,256}?\s-p)(["']?)[^\s"']{1,4096}/g;

/**
 * An AWS secret access key next to its name, as `aws configure` or a
 * credentials file has it: 40 characters that look like nothing on their own.
 */
const AWS_SECRET =
  /(\baws[A-Za-z0-9_.-]{0,32}secret[A-Za-z0-9_.-]{0,32}["']?\s{0,8}[\s=:,]\s{0,8}["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+=])/gi;

/** Credentials that keep the text around them: the name, header or flag stays. */
const LABELLED_PATTERNS: Array<[RegExp, string]> = [
  [AUTH_HEADER, `$1$2${REDACTED}`],
  [NAMED_KEY_HEADER, `$1${REDACTED}`],
  [COOKIE_HEADER, `$1${REDACTED}`],
  [CURL_USER, `$1${REDACTED}`],
  [MYSQL_PASSWORD, `$1$2${REDACTED}`],
  [AWS_SECRET, `$1${REDACTED}`],
];

/**
 * A token's prefix starts it only where no letter or digit comes before, so
 * `MY_ghp_…` is caught and `xghp_` is not; `\b` would miss the first, since
 * `_` is a word character.
 */
const START = "(?<![A-Za-z0-9])";

/** Known token shapes; each hit is replaced wholesale. */
const TOKEN_PATTERNS: RegExp[] = [
  new RegExp(`${START}(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Za-z0-9])`, "g"), // AWS access key ids
  new RegExp(`${START}gh[pousr]_[A-Za-z0-9]{20,}`, "g"), // GitHub tokens
  new RegExp(`${START}github_pat_[A-Za-z0-9_]{20,}`, "g"), // GitHub fine-grained tokens
  new RegExp(`${START}gl(?:pat|ptt|dt|rt|cbt|soat|ft|imt|agent)-[A-Za-z0-9_-]{20,}`, "g"), // GitLab tokens
  new RegExp(`${START}xox[abeprs](?:\\.xox[abeprs])?-[A-Za-z0-9-]{10,}`, "g"), // Slack tokens
  new RegExp(`${START}xapp-\\d-[A-Za-z0-9-]{10,}`, "g"), // Slack app tokens
  /\bhttps:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9_/-]{8,}/gi, // Slack webhooks
  /\bhttps:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gi, // Discord webhooks
  new RegExp(`${START}AIza[0-9A-Za-z_-]{35}`, "g"), // Google API keys
  new RegExp(`${START}sk-[A-Za-z0-9_-]{20,}`, "g"), // OpenAI and Anthropic keys, sk-proj- and sk-ant- too
  new RegExp(`${START}[sr]k_(?:live|test)_[A-Za-z0-9]{10,}`, "g"), // Stripe secret and restricted keys
  new RegExp(`${START}whsec_[A-Za-z0-9]{20,}`, "g"), // Stripe webhook secrets
  new RegExp(`${START}npm_[A-Za-z0-9]{30,}`, "g"), // npm tokens
  new RegExp(`${START}hf_[A-Za-z0-9]{30,}`, "g"), // Hugging Face tokens
  new RegExp(`${START}sntry[su]_[A-Za-z0-9_=-]{20,}`, "g"), // Sentry auth tokens
  new RegExp(`${START}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}`, "g"), // JWTs
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, // bearer headers
  URL_CREDENTIALS,
  /\bhttps?:\/\/[0-9a-f]{32}@[^\s/]{1,256}\/\d+/gi, // Sentry DSNs
];

/**
 * Replaces secrets in free text: PEM blocks, dotenv lines, inline assignments,
 * quoted pairs and known token shapes. `cut` says which ends were cut off, where
 * a lone key marker is taken to be a key that runs on past the cut.
 */
export function scrubSecrets(value: string, cut: Cut = {}): string {
  let out = value;
  if (out.includes(KEY_MARKER)) {
    out = scrubWholeKeys(out);
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
  for (const [pattern, replacement] of LABELLED_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(BASIC_CREDENTIALS, (match, encoded: string) =>
    isBasicCredential(encoded) ? `Basic ${REDACTED}` : match,
  );
  for (const pattern of TOKEN_PATTERNS) out = out.replace(pattern, REDACTED);
  return out;
}

/** A field named like a credential, as in `{"apiKey": "…"}`. */
export const CREDENTIAL_KEY = new RegExp(
  `^[A-Za-z0-9_.-]{0,64}${CREDENTIAL_NAME}[A-Za-z0-9_.-]{0,64}$`,
  "i",
);

