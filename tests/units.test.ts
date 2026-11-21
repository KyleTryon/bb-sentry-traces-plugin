import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { modelStretches } from "../src/core/breakdown.js";
import { attributes, hexId, span as otlpSpan, spanIdFor, traceIdFor } from "../src/core/otlp.js";
import { Exporter } from "../src/export/exporter.js";
import { recap, rescrub, scrub, scrubLine, scrubTail } from "../src/core/scrub/cut.js";
import { scrubSecrets } from "../src/core/scrub/secrets.js";
import { scrubText, scrubValue } from "../src/core/scrub/value.js";
import { batches, MAX_REQUEST_BYTES, MAX_SPANS_PER_REQUEST, parseDsn, sendSpans } from "../src/sentry.js";
import { syntheticSpans } from "../src/synthetic.js";
import { TraceBuilder } from "../src/core/trace/builder.js";
import { parseRawUsage, toSentryUsage, usageDelta } from "../src/core/usage.js";
import { VERSION } from "../src/version.js";
import { DSN, fakeFetch, History, SECRETS } from "./helpers.js";

const KEY_BODY = "MIIEowIBAAKCAQEA".repeat(200);
const PEM = `-----BEGIN RSA PRIVATE KEY-----\n${KEY_BODY}\n-----END RSA PRIVATE KEY-----`;
const BODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7";
const BEGIN = "-----BEGIN PRIVATE KEY-----";

/** The item at `index`; the test fails when there is none. */
function itemAt<T>(items: readonly T[], index: number): T {
  const item = items.at(index);
  if (item === undefined) throw new Error(`no item at index ${index}`);
  return item;
}

describe("version", () => {
  it("matches package.json", () => {
    const manifest = z
      .object({ version: z.string() })
      .parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    expect(VERSION).toBe(manifest.version);
  });
});

describe("parseDsn", () => {
  it("derives the OTLP endpoint and auth header", () => {
    const parsed = parseDsn(DSN);
    expect(parsed).toEqual({
      ok: true,
      target: {
        endpoint:
          "https://o42.ingest.us.sentry.io/api/4500000000000001/integration/otlp/v1/traces",
        authHeader: "sentry sentry_key=0123456789abcdef0123456789abcdef",
        host: "o42.ingest.us.sentry.io",
        projectId: "4500000000000001",
      },
    });
  });

  it("keeps a self-hosted path prefix in front of /api", () => {
    const parsed = parseDsn("https://key@sentry.example.com/prefix/7");
    expect(parsed.ok && parsed.target.endpoint).toBe(
      "https://sentry.example.com/prefix/api/7/integration/otlp/v1/traces",
    );
  });

  it.each([
    ["", "No DSN is set."],
    [undefined, "No DSN is set."],
    ["not a url", "The DSN is not a URL."],
    ["ftp://key@host/1", "The DSN must start with https:// or http://."],
    ["https://host/1", "The DSN has no public key before the @."],
    ["https://key@host/", "The DSN does not end with a project id."],
  ])("rejects %j", (dsn, reason) => {
    expect(parseDsn(dsn)).toEqual({ ok: false, reason });
  });

  it("refuses a DSN whose key does not decode instead of throwing", () => {
    expect(parseDsn("https://abc%E0@o1.ingest.sentry.io/1")).toEqual({
      ok: false,
      reason: "The DSN's public key is not valid.",
    });
  });
});

describe("ids", () => {
  it("are stable, the right length, and differ by key", () => {
    expect(traceIdFor("a")).toBe(traceIdFor("a"));
    expect(traceIdFor("a")).toMatch(/^[0-9a-f]{32}$/);
    expect(spanIdFor("a")).toMatch(/^[0-9a-f]{16}$/);
    expect(traceIdFor("a")).not.toBe(traceIdFor("b"));
    expect(hexId("x", 8)).not.toMatch(/^0+$/);
  });
});

describe("attributes", () => {
  it("drops empty values and types the rest", () => {
    expect(
      attributes({ a: "x", b: 3, c: 1.5, d: true, e: null, f: undefined, g: "", h: Number.NaN }),
    ).toEqual([
      { key: "a", value: { stringValue: "x" } },
      { key: "b", value: { intValue: "3" } },
      { key: "c", value: { doubleValue: 1.5 } },
      { key: "d", value: { boolValue: true } },
    ]);
  });
});

describe("token usage", () => {
  // Real totals from a Claude Code thread: input excludes cache reads and writes.
  const claude = parseRawUsage({
    totalTokens: 6_658_803,
    inputTokens: 72,
    cachedInputTokens: 6_614_941,
    cacheReadInputTokens: 6_341_125,
    cacheWriteInputTokens: 273_816,
    outputTokens: 43_790,
    reasoningOutputTokens: 0,
  })!;

  it("adds cached tokens to an input that excludes them", () => {
    expect(toSentryUsage(claude)).toEqual({
      inputTokens: 6_615_013,
      outputTokens: 43_790,
      totalTokens: 6_658_803,
      cacheReadTokens: 6_341_125,
      cacheWriteTokens: 273_816,
      reasoningTokens: 0,
    });
  });

  it("leaves an input that already includes cached tokens alone", () => {
    const codex = parseRawUsage({
      totalTokens: 1_500,
      inputTokens: 1_000,
      cachedInputTokens: 800,
      outputTokens: 500,
      reasoningOutputTokens: 200,
    })!;
    expect(toSentryUsage(codex)).toEqual({
      inputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 1_500,
      cacheReadTokens: 800,
      cacheWriteTokens: 0,
      reasoningTokens: 200,
    });
  });

  it("adds reasoning tokens to an output that excludes them", () => {
    const usage = parseRawUsage({
      totalTokens: 1_700,
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 500,
      reasoningOutputTokens: 200,
    })!;
    expect(toSentryUsage(usage)).toMatchObject({ outputTokens: 700, reasoningTokens: 200 });
  });

  it("falls back to comparing cached and input when there is no usable total", () => {
    const usage = parseRawUsage({ inputTokens: 10, cachedInputTokens: 900, outputTokens: 5 })!;
    expect(toSentryUsage(usage).inputTokens).toBe(910);
  });

  it("takes the difference between two totals, and refuses a total that went backwards", () => {
    const earlier = { ...claude, totalTokens: 5_000_000, cachedInputTokens: 4_956_138 };
    const delta = usageDelta(claude, earlier)!;
    expect(delta.totalTokens).toBe(1_658_803);
    expect(delta.inputTokens).toBe(0);
    expect(usageDelta(earlier, claude)).toBeNull();
    expect(usageDelta(claude, null)).toBe(claude);
  });

  it("ignores malformed usage", () => {
    expect(parseRawUsage({ inputTokens: "many" })).toBeNull();
  });

  it("does not count a whole cache total as one stretch's when the earlier total had no split", () => {
    const base = {
      totalTokens: 1_000,
      inputTokens: 100,
      cachedInputTokens: 800,
      outputTokens: 100,
      reasoningOutputTokens: 0,
    };
    const earlier = { ...base, cacheReadInputTokens: null, cacheWriteInputTokens: null };
    const now = {
      ...base,
      totalTokens: 2_000,
      cachedInputTokens: 1_600,
      inputTokens: 200,
      outputTokens: 200,
      cacheReadInputTokens: 1_500,
      cacheWriteInputTokens: 100,
    };
    const delta = usageDelta(now, earlier)!;
    expect(delta.cacheReadInputTokens).toBeNull();
    expect(delta.cacheWriteInputTokens).toBeNull();
    expect(toSentryUsage(delta).cacheReadTokens).toBe(800);
  });
});

describe("scrubSecrets", () => {
  it("replaces known secret shapes and keeps the rest", () => {
    const text = [
      "Deploy notes",
      "export API_KEY=abc123",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123",
      "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwx'",
      "postgres://admin:hunter2@db.internal/app",
      DSN,
      "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const scrubbed = scrubSecrets(text);
    expect(scrubbed).toContain("Deploy notes");
    for (const secret of ["abc123", "ghp_", "abcdefghijklmnopqrstuvwx", "hunter2", "MIIabc"]) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).not.toContain("0123456789abcdef0123456789abcdef");
  });

  it("leaves ordinary lines that only look like credentials alone", () => {
    const text = "Author: Ada Lovelace\ninput_tokens: 500\nSESSION_ID=abc";
    expect(scrubSecrets(text)).toBe("Author: Ada Lovelace\ninput_tokens: 500\nSESSION_ID=[redacted]");
  });

  it("redacts a private key whose end or start was cut off", () => {
    expect(scrubSecrets(PEM.slice(0, 1_000))).not.toContain("MIIEow");
    expect(scrubSecrets(PEM.slice(-1_000))).not.toContain("MIIEow");
  });

  it("scrubs before it cuts, so a cut cannot hide a secret", () => {
    const text = `output:\n${PEM}\nmore`;
    expect(scrub(text, 500)).not.toContain("MIIEow");
    expect(scrubTail(text, 500)).not.toContain("MIIEow");
    const token = `ghp_${"a".repeat(36)}`;
    // Cut inside the token: the part kept is still recognized as one.
    expect(scrub(`x ${token}`, 15)).not.toContain("ghp_aaaa");
    expect(scrubLine(`curl -H "Authorization: Bearer ${"b".repeat(40)}"`, 40)).not.toContain("bbbb");
    expect(scrub("short", 100)).toBe("short");
    expect(scrub("a".repeat(30), 10)).toBe(`${"a".repeat(10)}\n[… 20 more characters cut]`);
    expect(scrubTail("a".repeat(30), 10)).toBe(`[… 20 earlier characters cut]\n${"a".repeat(10)}`);
  });

  it("redacts quoted credential fields, but not look-alikes", () => {
    expect(scrubSecrets('{"api_key": "abcd1234supersecret", "name": "x"}')).toBe(
      '{"api_key": "[redacted]", "name": "x"}',
    );
    expect(scrubSecrets("{'clientSecret': 'hunter2'}")).toBe("{'clientSecret': '[redacted]'}");
    expect(scrubSecrets('{"Authorization": "Basic dXNlcjpwYXNz"}')).toBe('{"Authorization": "[redacted]"}');
    expect(scrubSecrets("AUTHORIZATION=Basic dXNlcjpwYXNz")).toBe("AUTHORIZATION=[redacted]");
    expect(scrubSecrets('{"author": "Ada", "max_tokens": "100"}')).toBe('{"author": "Ada", "max_tokens": "100"}');
  });

  it("redacts credentials assigned inline, as in a command inside one-line JSON", () => {
    const args = JSON.stringify({ command: "STRIPE_SECRET_KEY=rk_live_abc123 npm start" });
    expect(scrubSecrets(args)).toBe('{"command":"STRIPE_SECRET_KEY=[redacted] npm start"}');
    expect(scrubSecrets("cd app && API_KEY=s3cr3t ./run.sh")).toBe("cd app && API_KEY=[redacted] ./run.sh");
    expect(scrubSecrets('x; export GH_TOKEN="two words" && y')).toBe("x; export GH_TOKEN=[redacted] && y");
    const quoted = JSON.stringify({ command: 'DB_PASSWORD="hunter two" psql' });
    expect(scrubSecrets(quoted)).not.toContain("hunter");
    // Comparisons and look-alikes stay.
    expect(scrubSecrets("if (token===x) max_tokens=100 author=ada")).toBe(
      "if (token===x) max_tokens=100 author=ada",
    );
  });

  it("keeps text that only mentions a private key marker", () => {
    const code = 'if (line === "-----END PRIVATE KEY-----") done();\nconst next = 1;';
    expect(scrubSecrets(`const header = 1;\n${code}`)).toBe(`const header = 1;\n${code}`);
    const begin = 'write("-----BEGIN PRIVATE KEY-----");\nwrite(body);';
    expect(scrubSecrets(begin)).toBe(begin);
  });

  it("redacts a cut-off key with header lines or a note after it, and keeps what follows", () => {
    const encrypted = `-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,ABC\n\n${BODY}\n${BODY}`;
    expect(scrubSecrets(encrypted)).toBe("[redacted]");
    const noted = `cat key.pem\n-----BEGIN PRIVATE KEY-----\n${BODY}\n${BODY}\n...(output truncated)`;
    expect(scrubSecrets(noted)).toBe("cat key.pem\n[redacted]\n...(output truncated)");
    const before = `(earlier output cut)\n${BODY}\nQ2==\n-----END PRIVATE KEY-----\ndone`;
    expect(scrubSecrets(before)).toBe("(earlier output cut)\n[redacted]\ndone");
    // A tool result as JSON: its line breaks are `\n` written out.
    const json = JSON.stringify({ output: `-----BEGIN PRIVATE KEY-----\n${BODY}\n${BODY}` });
    expect(scrubSecrets(json)).not.toContain("MIIEvQ");
  });

  it("redacts the whole of an inline value with a backslash or an unclosed quote", () => {
    expect(scrubSecrets("cd x && PASSWORD=ab\\cdsecret npm start")).toBe(
      "cd x && PASSWORD=[redacted] npm start",
    );
    expect(scrubSecrets('TOKEN="abc def npm start\nnext line')).toBe("TOKEN=[redacted]\nnext line");
    // An escaped quote that closes a JSON string stays.
    expect(scrubSecrets(JSON.stringify({ command: 'echo "API_KEY=abc"' }))).toBe(
      '{"command":"echo \\"API_KEY=[redacted]\\""}',
    );
  });

  it("redacts a cut-off key whose lines end in spaces, or that sits on one line", () => {
    expect(scrubSecrets(`${BEGIN}\n${BODY} \n${BODY}\t\n${BODY} `)).toBe("[redacted] ");
    expect(scrubSecrets(`${BEGIN} ${BODY} ${BODY}`)).toBe("[redacted]");
    expect(scrubSecrets(`${BODY} ${BODY} Q2== -----END PRIVATE KEY-----`)).toBe("[redacted]");
  });

  it("keeps the text that follows a cut-off key", () => {
    expect(scrubSecrets(`${BEGIN}\n${BODY}\nexit code 0\nnext`)).toBe("[redacted]\nexit code 0\nnext");
    expect(scrubSecrets(`key: |\n  ${BEGIN}\n  ${BODY}\nnext: 1`)).toBe("key: |\n  [redacted]\nnext: 1");
    // One word alone on the line right after the key could be its last line, so it goes too.
    expect(scrubSecrets(`${BEGIN}\n${BODY}\ndone\nok\nfine\nreally fine`)).toBe(
      "[redacted]\nok\nfine\nreally fine",
    );
    // The short last line of a key is still part of it.
    expect(scrubSecrets(`${BEGIN}\n${BODY}\nQ2==\nexit`)).toBe("[redacted]\nexit");
  });

  it("redacts the rest of the line when a quote after a credential name may open a value", () => {
    // Nothing says for certain that these quotes close a string, so the doubt redacts.
    expect(scrubSecrets("grep -rn 'API_KEY=' src && echo done")).toBe("grep -rn 'API_KEY=[redacted]");
    expect(scrubSecrets("if (arg.startsWith('--password=')) { run(arg); }")).toBe(
      "if (arg.startsWith('--password=[redacted]",
    );
    // In a structured value the loss stays inside the one string.
    expect(scrubValue({ command: "grep -rn 'API_KEY=' .", timeout: 5000 }, 4_000)).toBe(
      `{"command":"grep -rn 'API_KEY=[redacted]","timeout":5000}`,
    );
    // A quote that clearly opens a value has just that value redacted, an apostrophe before it or not.
    expect(scrubSecrets("Here's how: TOKEN='abc def' then run")).toBe("Here's how: TOKEN=[redacted] then run");
    expect(scrubSecrets(`echo "x" && TOKEN="a b" run`)).toBe(`echo "x" && TOKEN=[redacted] run`);
    expect(scrubSecrets(JSON.stringify({ command: 'DB_PASSWORD="hunter two" psql' }))).toBe(
      '{"command":"DB_PASSWORD=[redacted] psql"}',
    );
  });

  it("scrubs output of one long token per line without slowing down", () => {
    const text = Array.from({ length: 2_000 }, (_, index) =>
      (index.toString(16).padStart(8, "0") + "0123456789abcdef").repeat(2).slice(0, 40),
    ).join("\n");
    const started = performance.now();
    for (let run = 0; run < 5; run++) scrub(text, 16_000);
    expect(performance.now() - started).toBeLessThan(150);
  });

  it("redacts a credential that follows a quoted credential name on the same line", () => {
    expect(scrubSecrets('grep "API_KEY=" .env && PASSWORD=hunter2 psql -c "select 1"')).not.toContain("hunter2");
    expect(scrubSecrets("grep 'API_KEY=' .env; SECRET=abc123 run 'x'")).not.toContain("abc123");
    expect(scrubSecrets("grep 'API_KEY=' .env && SECRET=abc123 run")).toBe("grep 'API_KEY=[redacted]");
  });

  it("redacts a quoted value that is not closed on its line", () => {
    expect(scrubSecrets('cd app && API_KEY="sk_live_abc def')).toBe("cd app && API_KEY=[redacted]");
    expect(scrubSecrets("run && TOKEN='abcdef ghijkl")).toBe("run && TOKEN=[redacted]");
    expect(scrubSecrets('cd app && SECRET="line one\nline two" npm start')).toBe(
      "cd app && SECRET=[redacted] npm start",
    );
    expect(scrubValue({ command: 'cd app && API_KEY="sk_live_abc def' }, 4_000)).toBe(
      '{"command":"cd app && API_KEY=[redacted]"}',
    );
  });

  it("redacts a quoted value whatever it starts with and whatever quotes come before it", () => {
    const json = `{"note":"Don't forget","command":"PASSWORD=':s3cr3t!' ./run"}`;
    expect(scrubSecrets(json)).toBe(`{"note":"Don't forget","command":"PASSWORD=[redacted] ./run"}`);
    expect(scrubSecrets("it's fine: PASSWORD=' leading space pw' go")).toBe("it's fine: PASSWORD=[redacted] go");
  });

  it("redacts a cut-off key's short last line even when it looks like a word", () => {
    for (const last of ["abcdefgh", "QWERTYUI", "Abcdefgh"]) {
      expect(scrubSecrets(`${BEGIN}\n${BODY}\n${last}\nexit`)).toBe("[redacted]\nexit");
      expect(scrubSecrets(`${BODY}\n${last}\n-----END PRIVATE KEY-----`)).toBe("[redacted]");
    }
  });

  it("scrubs a long line of quoted credential names without slowing down", () => {
    const command = JSON.stringify({ command: 'grep "TOKEN=" . '.repeat(3_000) });
    expect(command.length).toBeGreaterThan(48_000);
    const started = performance.now();
    for (let run = 0; run < 3; run++) scrubSecrets(command);
    expect(performance.now() - started).toBeLessThan(100);
  });

  it("redacts a quoted secret that follows a quoted credential name on the same line", () => {
    expect(scrubSecrets("grep 'API_KEY=' .env; SECRET='abc123'")).toBe("grep 'API_KEY=[redacted]");
    expect(scrubSecrets('echo "PASSWORD=" && TOKEN="abc def" run')).toBe('echo "PASSWORD=[redacted]');
    expect(scrubSecrets("grep 'API_KEY=' x; SECRET='abc' # don't")).toBe("grep 'API_KEY=[redacted]");
    // A later apostrophe does not make the value's own quotes look like a closed string.
    expect(scrubSecrets(`TOKEN='abc' git commit -m "don't break"`)).toBe("TOKEN=[redacted]");
    expect(scrubSecrets(`cd x && TOKEN='abc' git commit -m "don't break"`)).toBe("cd x && TOKEN=[redacted]");
    const args = scrubValue({ command: "grep 'API_KEY=' . && PASSWORD='hunter2' run", cwd: "/app" }, 4_000);
    expect(args).toBe(`{"command":"grep 'API_KEY=[redacted]","cwd":"/app"}`);
  });

  it("redacts a quoted value that runs over several lines or starts with a space", () => {
    expect(scrubSecrets('PASSWORD=" leading space\nmore" x')).toBe("PASSWORD=[redacted]");
    expect(scrubSecrets('x && PASSWORD=" spacey secret')).toBe("x && PASSWORD=[redacted]");
    expect(scrubSecrets("run && SECRET='\nline two\nline three' && next")).toBe("run && SECRET=[redacted] && next");
  });

  it("keeps a word after a cut-off key that is not alone on its line", () => {
    expect(scrubSecrets(`${BEGIN}\n${BODY}\nok!\nnext`)).toBe("[redacted]\nok!\nnext");
    expect(scrubSecrets(`${BEGIN}\n${BODY}\ndone.\nnext`)).toBe("[redacted]\ndone.\nnext");
  });

  it("redacts a cut-off key's short last line at the end of a JSON string", () => {
    const output = `${BEGIN}\n${BODY}\nabcdefgh`;
    expect(scrubValue({ output }, 4_000)).toBe('{"output":"[redacted]"}');
    expect(scrubSecrets(JSON.stringify({ output }))).toBe('{"output":"[redacted]"}');
  });
});

describe("truncation", () => {
  it("does not cut text again that was already cut to the cap", () => {
    const reply = `${"a".repeat(20_000)}THE-END`;
    const kept = scrubTail(reply, 16_000);
    expect(rescrub(kept, 16_000, "end")).toBe(kept);
    const args = scrub("b".repeat(6_000), 4_000);
    expect(rescrub(args, 4_000)).toBe(args);
    expect(rescrub("c".repeat(9_000), 4_000)).toBe(scrub("c".repeat(9_000), 4_000));
  });

  it("cuts text that is over the cap and was never cut, however little it is over", () => {
    const text = "d".repeat(4_010);
    expect(rescrub(text, 4_000)).toBe(scrub(text, 4_000));
    expect(rescrub(text, 4_000, "end")).toBe(scrubTail(text, 4_000));
    expect(rescrub("short", 4_000)).toBe("short");
  });
});

describe("structured values", () => {
  it("scrubs each string of a structured value on its own, so JSON's quotes are never a command's", () => {
    for (const value of [
      { command: "grep -r TOKEN=", description: "find tokens" },
      { pattern: "API_KEY=", path: "src" },
      ["--password=", "next"],
    ]) {
      expect(scrubValue(value, 4_000)).toBe(JSON.stringify(value));
    }
    expect(scrubValue({ api_key: "abcd1234", name: "x", nested: { clientSecret: "hunter2" } }, 4_000)).toBe(
      '{"api_key":"[redacted]","name":"x","nested":{"clientSecret":"[redacted]"}}',
    );
    expect(scrubValue({ author: "Ada", max_tokens: "100", n: 3, ok: true, none: null }, 4_000)).toBe(
      '{"author":"Ada","max_tokens":"100","n":3,"ok":true,"none":null}',
    );
    expect(scrubValue("plain TOKEN=abc text", 4_000)).toBe("plain TOKEN=[redacted] text");
    expect(scrubValue(undefined, 4_000)).toBe("");
    // The same rule for text that is JSON, as a provider's message content is.
    const messages = JSON.stringify([{ role: "user", content: "run grep 'API_KEY=' src", id: 7 }]);
    expect(scrubText(messages, 8_000)).toBe(
      `[{"role":"user","content":"run grep 'API_KEY=[redacted]","id":7}]`,
    );
    expect(scrubText("{not json TOKEN=abc", 8_000)).toBe("{not json TOKEN=[redacted]");
  });

  it("caps a structured value with the true size of the cut, and leaves it alone on its way out", () => {
    const args = scrubValue({ query: "q".repeat(6_000) }, 4_000);
    expect(args).toMatch(/\[… 2012 more characters cut\]$/);
    expect(recap(args, 4_000)).toBe(args);
    const json = `{"pattern":"API_KEY=","path":"src"}`;
    expect(recap(json, 4_000)).toBe(json);
    expect(recap("x".repeat(4_010), 4_000)).toBe(`${"x".repeat(4_000)}\n[… 10 more characters cut]`);
    // A secret past the cut is scrubbed before the cut, not split by it.
    const token = `ghp_${"a".repeat(36)}`;
    expect(scrubValue({ a: "x".repeat(3_980), b: token }, 4_000)).not.toContain("ghp_aaaa");
  });
});

describe("sendSpans", () => {
  const target = (() => {
    const parsed = parseDsn(DSN);
    if (!parsed.ok) throw new Error("bad test DSN");
    return parsed.target;
  })();
  const { spans } = syntheticSpans(1_800_000_000_000, "t");

  it("posts JSON with the DSN's key and reports what it sent", async () => {
    const { fetchImpl, sent } = fakeFetch();
    const result = await sendSpans(target, spans, { pluginVersion: "1", environment: "dev" }, fetchImpl);
    expect(result).toMatchObject({ ok: true, spans: spans.length });
    expect(sent).toHaveLength(1);
    const request = itemAt(sent, 0);
    expect(request.url).toBe(target.endpoint);
    expect(request.headers).toEqual({
      "content-type": "application/json",
      "x-sentry-auth": target.authHeader,
    });
    expect(itemAt(request.body.resourceSpans, 0).resource.attributes).toContainEqual({
      key: "deployment.environment.name",
      value: { stringValue: "dev" },
    });
  });

  it("splits a large export into several requests", async () => {
    const { fetchImpl, sent } = fakeFetch();
    const many = Array.from({ length: MAX_SPANS_PER_REQUEST + 5 }, () => itemAt(spans, 0));
    const result = await sendSpans(target, many, { pluginVersion: "1" }, fetchImpl);
    expect(result.spans).toBe(many.length);
    expect(sent.map((request) => request.spans.length)).toEqual([MAX_SPANS_PER_REQUEST, 5]);
  });

  it("marks a rejected key as not worth retrying, and an outage as retryable", async () => {
    const rejected = await sendSpans(target, spans, { pluginVersion: "1" }, fakeFetch(() => 401).fetchImpl);
    expect(rejected).toMatchObject({ ok: false, status: 401, retryable: false });
    const down = await sendSpans(target, spans, { pluginVersion: "1" }, fakeFetch(() => 503).fetchImpl);
    expect(down).toMatchObject({ ok: false, status: 503, retryable: true });
    const offline = await sendSpans(
      target,
      spans,
      { pluginVersion: "1" },
      fakeFetch(() => new Error("ECONNREFUSED")).fetchImpl,
    );
    expect(offline).toMatchObject({ ok: false, status: null, retryable: true });
    expect(offline.message).not.toContain("0123456789abcdef");
  });

  it("splits requests by size as well as by count", () => {
    const big = (index: number) =>
      otlpSpan({
        traceId: traceIdFor("t"),
        spanId: spanIdFor(`s${index}`),
        name: "big",
        start: 0,
        end: 1,
        attributes: { blob: "x".repeat(30_000) },
      });
    const spans = Array.from({ length: 200 }, (_, index) => big(index));
    const split = batches(spans);
    expect(split.flat()).toEqual(spans);
    for (const batch of split) {
      expect(batch.length).toBeLessThanOrEqual(MAX_SPANS_PER_REQUEST);
      expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(MAX_REQUEST_BYTES + 1_000);
    }
    expect(split.length).toBeGreaterThan(1);
  });
});

describe("TraceBuilder", () => {
  it("folds a turn with its model, calls and timing", () => {
    const history = new History();
    history.turn();
    const builder = new TraceBuilder({ content: false });
    builder.apply(history.events);
    const turn = itemAt(builder.snapshot(history.now), 0);
    expect(turn).toMatchObject({
      id: "turn-1",
      index: 1,
      model: "claude-fable-5-2",
      reasoningLevel: "high",
      serviceTier: "default",
      status: "completed",
      input: null,
      replies: [],
    });
    expect(turn.spans.map((span) => [span.kind, span.toolName, span.status])).toEqual([
      ["command", "shell", "completed"],
      ["tool", "mcp__docs__search", "completed"],
      ["read", "Read", "completed"],
    ]);
    expect(itemAt(turn.spans, 0).exitCode).toBe(0);
    expect(turn.activity.map((activity) => activity.kind)).toEqual(["thinking", "writing"]);
    expect(modelStretches(turn, history.now).length).toBeGreaterThan(1);
  });

  it("keeps nothing the user or model wrote when content is off", () => {
    const history = new History();
    history.turn();
    const builder = new TraceBuilder({ content: false });
    builder.apply(history.events);
    const kept = JSON.stringify(builder.snapshot(history.now));
    for (const secret of Object.values(SECRETS)) expect(kept).not.toContain(secret);
  });

  it("keeps the prompt, replies, arguments and outputs when content is on", () => {
    const history = new History();
    history.turn();
    const builder = new TraceBuilder({ content: true });
    builder.apply(history.events);
    const turn = itemAt(builder.snapshot(history.now), 0);
    expect(turn.input).toBe(SECRETS.prompt);
    expect(turn.replies).toEqual([SECRETS.reply]);
    expect(itemAt(turn.spans, 0)).toMatchObject({
      name: "deploy-acme-prod.sh",
      args: SECRETS.command,
      result: SECRETS.output,
    });
    expect(itemAt(turn.spans, 1)).toMatchObject({
      args: JSON.stringify({ query: SECRETS.toolArg }),
      result: SECRETS.toolResult,
    });
  });

  it("nests a subagent's calls under it and marks failures", () => {
    const history = new History();
    history.request("req-1").start("turn-1", "req-1");
    history.push(
      "item/started",
      {
        item: {
          type: "toolCall",
          id: "agent-1",
          tool: "Agent",
          arguments: { description: SECRETS.label, subagent_type: "Explore" },
          status: "pending",
        },
      },
      "turn-1",
    );
    history.push("turn/started", { parentToolCallId: "agent-1" }, "sub-turn");
    history.item(
      "sub-turn",
      { type: "commandExecution", id: "sub-cmd", command: "false" },
      200,
      { status: "failed", exitCode: 1, error: SECRETS.toolError },
    );
    history.push("turn/completed", { status: "completed" }, "sub-turn");
    history.push(
      "item/completed",
      { item: { type: "toolCall", id: "agent-1", tool: "Agent", arguments: {}, status: "completed" } },
      "turn-1",
    );
    history.complete("turn-1", "failed", "overloaded");

    const builder = new TraceBuilder({ content: false });
    builder.apply(history.events);
    const turns = builder.snapshot(history.now);
    expect(turns).toHaveLength(1);
    const turnSpans = itemAt(turns, 0).spans;
    const agent = itemAt(turnSpans, 0);
    const command = itemAt(turnSpans, 1);
    // The kind of agent is kept; the task it was given is not.
    expect(agent).toMatchObject({
      kind: "subagent",
      toolName: "Agent",
      agent: "Explore",
      name: "Explore",
      detail: "",
    });
    expect(agent.callEnd).toBeGreaterThan(agent.start);
    expect(JSON.stringify(turns)).not.toContain(SECRETS.label);
    expect(command).toMatchObject({
      parentId: "agent-1",
      status: "failed",
      exitCode: 1,
      errorType: "tool_error",
      error: null,
    });
    expect(turns[0]).toMatchObject({ status: "failed", error: "overloaded" });
  });

  it("refuses free text as a subagent's kind", () => {
    const history = new History();
    history.request("req-1").start("turn-1", "req-1");
    history.item("turn-1", {
      type: "toolCall",
      id: "agent-1",
      tool: "Task",
      arguments: { subagent_type: `do ${SECRETS.label} now` },
    });
    history.complete("turn-1");
    const builder = new TraceBuilder({ content: false });
    builder.apply(history.events);
    expect(itemAt(itemAt(builder.snapshot(history.now), 0).spans, 0)).toMatchObject({
      toolName: "Task",
      agent: "subagent",
    });
  });

  it("continues numbering from an offset and reports a prompt no turn accepted yet", () => {
    const history = new History();
    history.turn();
    history.request("queued");
    const builder = new TraceBuilder({ content: false, indexOffset: 4 });
    builder.apply(history.events);
    expect(itemAt(builder.snapshot(history.now), 0).index).toBe(5);
    const queued = history.events.at(-1)!;
    expect(builder.earliestUnmatchedRequest(0)).toBe(queued.seq);
    expect(builder.earliestUnmatchedRequest(queued.createdAt + 1)).toBeNull();
  });
});

describe("export stats", () => {
  it("counts every success when many land at once", async () => {
    // Storage that yields between a read and a write, as a real one does.
    const rows = new Map<string, string>();
    const later = () => new Promise((resolve) => setTimeout(resolve, 0));
    const kv = {
      get: async <T>(key: string) => {
        await later();
        const raw = rows.get(key);
        return raw === undefined ? undefined : (JSON.parse(raw) as T);
      },
      set: async (key: string, value: unknown) => {
        await later();
        rows.set(key, JSON.stringify(value));
      },
      delete: async (key: string) => void rows.delete(key),
      list: async (prefix?: string) => [...rows.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    };
    const log = { debug: () => undefined, warn: () => undefined, info: () => undefined, error: () => undefined };
    const exporter = new Exporter({
      bb: { sdk: {}, log, storage: { kv } } as never,
      settings: async () => ({ dsn: DSN, enabled: true, captureContent: false, environment: "", providers: [] }),
    });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        index % 2 === 0 ? exporter.recordSuccess({ turns: 1, spans: 3 }) : exporter.recordFailure("nope"),
      ),
    );
    const stats = await exporter.stats();
    expect(stats.turnsSent).toBe(10);
    expect(stats.spansSent).toBe(30);
    expect(stats.failures).toBe(10);
  });
});