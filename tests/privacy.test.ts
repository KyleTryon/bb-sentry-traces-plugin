/**
 * What may leave the machine, especially with content capture off: provider
 * attributes, error text and free-text names, the scrubber's coverage and
 * speed, and the shape of what is sent (times, strings, redirects).
 */
import { describe, expect, it } from "vitest";
import { nanos, span as otlpSpan, attributes } from "../src/core/otlp.js";
import { recap, scrub, scrubLine, scrubTail } from "../src/core/scrub/cut.js";
import { scrubSecrets } from "../src/core/scrub/secrets.js";
import { scrubText, scrubValue } from "../src/core/scrub/value.js";
import { oneLine } from "../src/core/text.js";
import { TraceBuilder } from "../src/core/trace/builder.js";
import type { Turn } from "../src/core/trace/types.js";
import { turnSpans } from "../src/export/spans.js";
import { sanitizeAttributes, sanitizeContent, traceSchema } from "../src/integrations/providers/schema.js";
import { providerSpans } from "../src/integrations/providers/spans.js";
import type { TraceContext } from "../src/integrations/providers/types.js";
import { parseDsn, sendSpans } from "../src/sentry.js";
import type { ThreadInfo } from "../src/thread.js";
import { attr, DSN, History } from "./helpers.js";
import type { OtlpSpan } from "../src/core/otlp.js";

const THREAD: ThreadInfo = {
  id: "thr_one",
  title: "A title",
  projectId: "proj_1",
  providerId: "claude-code",
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  originKind: null,
  originPluginId: null,
  visibility: null,
  environmentId: "env_1",
  hostId: "host_1",
  isWorktree: null,
  branch: "kyle/secret-branch",
};

function context(overrides: Partial<TraceContext> = {}): TraceContext {
  return {
    provider: "example-provider",
    traceKey: "run_42",
    endedAt: null,
    parentKey: "root",
    agentId: null,
    agentName: null,
    model: null,
    pipeline: null,
    traceAttributes: {},
    attributes: {},
    ...overrides,
  };
}

function oneTurn(history: History, content: boolean, now = history.now + 1_000): Turn {
  const builder = new TraceBuilder({ content });
  builder.apply(history.events);
  const turn = builder.snapshot(now)[0];
  if (!turn) throw new Error("no turn");
  return turn;
}

function spansFor(turn: Turn, captureContent: boolean, trace: TraceContext | null = null) {
  return turnSpans(turn, { thread: THREAD, captureContent, now: turn.start + 60_000, trace, usage: new Map() });
}

/** Everything a list of spans would send, as one string. */
const wire = (spans: OtlpSpan[]) => JSON.stringify(spans);

describe("provider attributes", () => {
  const sneaky = {
    "gen_ai.input.messages": "secret prompt",
    "GEN_AI.output.messages": "secret reply",
    "gen_ai.tool.call.arguments": "secret args",
    "gen_ai.prompt": "secret prompt 2",
    "gen_ai.system_instructions": "secret system",
    "bb.environment.branch": "secret-branch",
    "bb.span.detail": "secret detail",
    "SENTRY.op": "evil",
    "Gen_Ai.Conversation.Id": "someone-else",
    "BB.Thread.id": "thr_other",
    "gen_ai.usage.input_tokens": 1_000_000,
    "gen_ai.cost.total": 99,
    "gen_ai.operation.name": "chat",
    "gen_ai.request.model": "fake-model",
    "gen_ai.response.model": "fake-model",
    "example.role": "coordinator",
  };

  it("keeps content, usage and plugin-owned keys out of thread and trace attributes", () => {
    const history = new History();
    history.turn();
    const trace = context({
      traceAttributes: sanitizeAttributes(sneaky),
      attributes: sanitizeAttributes(sneaky),
    });
    const spans = spansFor(oneTurn(history, false), false, trace);
    const sent = wire(spans);
    expect(sent).not.toContain("secret");
    expect(sent).not.toContain("evil");
    expect(sent).not.toContain("someone-else");
    expect(sent).not.toContain("fake-model");
    for (const span of spans) expect(attr(span, "gen_ai.usage.input_tokens")).toBeUndefined();
    for (const span of spans) {
      expect(attr(span, "example.role")).toBe("coordinator");
      expect(attr(span, "gen_ai.cost.total")).toBeUndefined();
    }
  });

  it("filters attributes that reached a context before this check", () => {
    // A context stored by an older version, or built some other way.
    const history = new History();
    history.turn();
    const trace = context({ traceAttributes: { ...sneaky }, attributes: { ...sneaky } });
    const spans = spansFor(oneTurn(history, false), false, trace);
    expect(wire(spans)).not.toContain("secret");
    for (const span of spans) expect(attr(span, "gen_ai.usage.input_tokens")).toBeUndefined();
  });

  it("keeps a provider's own model call usage, but not trace-wide usage on every span", () => {
    const trace = {
      key: "run_42",
      ended: true,
      attributes: { "gen_ai.usage.input_tokens": 1_000_000, "gen_ai.input.messages": "secret", "x.y": 1 },
      spans: [
        { key: "root", name: "run", start: 1, end: 10 },
        {
          key: "decide",
          name: "decide",
          start: 2,
          end: 3,
          attributes: {
            "gen_ai.operation.name": "decide",
            "gen_ai.request.model": "m",
            "gen_ai.usage.input_tokens": 400,
            "gen_ai.input.messages": "secret in attributes",
          },
        },
      ],
    };
    const spans = providerSpans(context(), traceSchema.parse(trace), false);
    const decide = spans.find((span) => span.name === "decide")!;
    const root = spans.find((span) => span.name === "run")!;
    expect(attr(decide, "gen_ai.usage.input_tokens")).toBe(400);
    expect(attr(decide, "gen_ai.request.model")).toBe("m");
    expect(attr(root, "gen_ai.usage.input_tokens")).toBeUndefined();
    expect(attr(root, "x.y")).toBe(1);
    expect(wire(spans)).not.toContain("secret");
  });

  it("scrubs provider content before cutting it, and caps it at the contract's 8,000 characters", () => {
    const out = sanitizeContent({
      a: `${"x".repeat(1_975)}postgres://admin:SuperSecretPw@db.internal/prod`,
      b: `${"y".repeat(7_989)} AKIAIOSFODNN7EXAMPLE`,
      c: "z".repeat(20_000),
    });
    expect(String(out["a"])).not.toContain("SuperSecret");
    expect(String(out["a"])).toContain("db.internal/prod");
    expect(String(out["b"])).not.toContain("AKIAIOSF");
    expect(String(out["c"]).startsWith("z".repeat(8_000))).toBe(true);
    expect(String(out["c"])).toContain("more characters cut");
  });

  it("does not let a provider's free-text error type through", () => {
    const trace = {
      key: "run_42",
      ended: true,
      spans: [
        { key: "a", name: "a", start: 1, end: 2, status: "error", errorType: "rm -rf /Users/x/secret failed" },
        { key: "b", name: "b", start: 1, end: 2, status: "error", errorType: "verify_failed" },
      ],
    };
    const spans = providerSpans(context(), traceSchema.parse(trace), false);
    expect(wire(spans)).not.toContain("secret");
    const b = spans.find((span) => span.name === "b")!;
    expect(b.status).toEqual({ code: 2, message: "verify_failed" });
  });
});

describe("error text without content capture", () => {
  const failing = (content: boolean) => {
    const history = new History();
    history.request("req-1").start("turn-1", "req-1");
    history.push(
      "provider/error",
      { message: "spawn /Users/x/secret/claude ENOENT", detail: "curl -H 'X-API-Key: 9944b09199c62bcf' failed" },
      "turn-1",
    );
    history.push("provider/error", { message: "overloaded_error", detail: "Overloaded" }, "turn-1");
    history.push("system/error", { message: "Could not read /Users/x/secret/plan.md", code: "ENOENT" }, "turn-1");
    history.push("system/thread/interrupted", { reason: "user said: drop the secret merger" }, "turn-1");
    history.push("system/thread/interrupted", { reason: "manual-stop" }, "turn-1");
    history.push(
      "provider/modelFallback",
      { fallbackModel: "claude-sonnet", reason: "the secret prompt was too long" },
      "turn-1",
    );
    history.complete("turn-1", "failed", "Command `rm -rf /Users/x/secret` failed: Basic dXNlcjpwYXNz");
    return oneTurn(history, content);
  };

  it("sends only fixed error types and identifier-like messages", () => {
    const spans = spansFor(failing(false), false);
    const sent = wire(spans);
    expect(sent).not.toContain("secret");
    expect(sent).not.toContain("dXNlcjpwYXNz");
    expect(sent).not.toContain("9944b09199c62bcf");
    expect(spans[0]!.status).toEqual({ code: 2, message: "turn failed" });
    expect(sent).toContain('"message":"overloaded_error"');
    expect(sent).toContain('"message":"ENOENT"');
    // The first provider error has no identifier to show, so its fixed type stands in.
    expect(sent).toContain('"message":"provider_error"');
  });

  it("keeps identifier-like turn errors and fallback reasons", () => {
    const history = new History();
    history.request("req-1").start("turn-1", "req-1");
    history.push("provider/modelFallback", { fallbackModel: "claude-sonnet", reason: "rate_limit_error" }, "turn-1");
    history.complete("turn-1", "failed", "overloaded_error");
    const spans = spansFor(oneTurn(history, false), false);
    expect(spans[0]!.status).toEqual({ code: 2, message: "overloaded_error" });
    expect(attr(spans[0]!, "bb.model_fallback.reason")).toBe("rate_limit_error");
  });

  it("guards the turn error even when the trace kept it", () => {
    // A turn folded with content on, sent with it off.
    const spans = spansFor(failing(true), false);
    expect(wire(spans)).not.toContain("secret");
  });

  it("sends error text, scrubbed, with content capture", () => {
    const spans = spansFor(failing(true), true);
    const sent = wire(spans);
    expect(sent).toContain("rm -rf /Users/x/secret");
    expect(sent).not.toContain("dXNlcjpwYXNz");
    expect(sent).not.toContain("9944b09199c62bcf");
    expect(attr(spans[0]!, "bb.model_fallback.reason")).toBe("the secret prompt was too long");
  });
});

describe("free-text names", () => {
  const withCalls = (content: boolean) => {
    const history = new History();
    history.request("req-1").start("turn-1", "req-1");
    for (const [id, tool] of [
      ["t1", "Read /Users/x/secret/plan.md"],
      ["t2", "mcp__docs__search"],
      ["t3", "bb_workflow_run"],
      ["t4", `x${"y".repeat(200)}`],
      ["t5", "mcp__bb-bridge__update_environment_directory"],
    ] as const) {
      history.item("turn-1", { type: "toolCall", id, tool, arguments: {} });
    }
    history.item("turn-1", {
      type: "toolCall",
      id: "a1",
      tool: "Agent",
      arguments: { subagent_type: "/Users/x/secret", prompt: "p" },
    });
    history.item("turn-1", { type: "toolCall", id: "a2", tool: "Agent", arguments: { subagent_type: "Explore" } });
    history.item("turn-1", { type: "some secret row type", id: "d1" });
    history.complete("turn-1");
    return oneTurn(history, content);
  };

  it("falls back to fixed names for tool and agent names that are not identifiers", () => {
    const spans = spansFor(withCalls(false), false);
    const names = spans.map((span) => span.name);
    expect(wire(spans)).not.toContain("secret");
    expect(wire(spans)).not.toContain("yyyy");
    expect(names).toContain("execute_tool mcp__docs__search");
    expect(names).toContain("execute_tool bb_workflow_run");
    expect(names).toContain("execute_tool mcp__bb-bridge__update_environment_directory");
    expect(names).toContain("execute_tool tool");
    expect(names).toContain("invoke_agent subagent");
    expect(names).toContain("invoke_agent Explore");
  });

  it("keeps them, scrubbed and capped, with content capture", () => {
    const spans = spansFor(withCalls(true), true);
    expect(spans.map((span) => span.name)).toContain("execute_tool Read /Users/x/secret/plan.md");
  });

  it("caps a provider's agent name, spaces and all", () => {
    const history = new History();
    history.turn();
    const spans = spansFor(oneTurn(history, false), false, context({ agentName: `Senior Dev ${"z".repeat(500)}` }));
    expect(spans[0]!.name.startsWith("invoke_agent Senior Dev")).toBe(true);
    expect(String(attr(spans[0]!, "gen_ai.agent.name")).length).toBeLessThanOrEqual(80);
  });
});

describe("scrubber coverage", () => {
  const leaks: Array<[string, string, string]> = [
    // [name, input, text that must not survive]
    ["stripe live", "stripe.api_key = sk_live_51H8abcdefghijklmnopqrstuvwxyz0123456789", "51H8abcdef"],
    ["stripe bare", "curl https://api.stripe.com -d x=sk_test_51H8abcdefghijklmnopqrstuvwx", "51H8abcdef"],
    ["stripe restricted", "rk_live_51H8abcdefghijklmnopqrstuvwxyz0123456789", "51H8abcdef"],
    ["npm", "token npm_abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnop"],
    ["gitlab", "glpat-abcdefghij0123456789", "abcdefghij0123"],
    ["slack app", "xapp-1-A0123456789-1234567890123-abcdef0123456789abcdef", "abcdef0123456789abcdef"],
    ["slack webhook", "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX", "XXXXXXXX"],
    ["aws sts", "ASIAIOSFODNN7EXAMPLE tmp", "IOSFODNN7"],
    ["aws secret bare", "aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtn"],
    ["aws secret ini", "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "wJalrXUtn"],
    [
      "pgp",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----",
      "lQOYBF0",
    ],
    ["redis empty user", "redis://:s3cr3tP4ssw0rd@redis.example.com:6379/0", "s3cr3t"],
    ["pg slash pw", "postgres://admin:ab/cd+ef==@db.internal:5432/prod", "ab/cd"],
    ["pg at pw", "postgres://admin:p@ssw0rd@db.internal/prod", "ssw0rd"],
    ["basic header", `curl -H "Authorization: Basic dXNlcjpodW50ZXIycGFzc3dvcmQ=" https://x`, "dXNlcjpo"],
    ["token header", "curl -H 'Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b' x", "9944b0"],
    ["api key header", "curl -H 'X-API-Key: 9944b09199c62bcf9418ad846dd0e4bb' https://x", "9944b0"],
    ["cookie header", "curl -H 'Cookie: sid=9944b09199c62bcf9418ad846dd0e4bb' x", "9944b0"],
    ["curl -u", "curl -u admin:hunter2pass https://x", "hunter2"],
    ["mysql -p", "mysql -u root -phunter2 db", "hunter2"],
    ["azure", "DefaultEndpointsProtocol=https;AccountName=x;AccountKey=abcDEF123+/==;EndpointSuffix=core", "abcDEF"],
    ["DB_PASS", "DB_PASS=hunter2", "hunter2"],
    ["MYSQL_PWD", "export MYSQL_PWD=hunter3", "hunter3"],
    ["STRIPE_KEY", "STRIPE_KEY=rawstripe123", "rawstripe"],
    ["SIGNING_KEY", "cd x && SIGNING_KEY=rawsign123 run", "rawsign"],
    ["yaml pass", "db:\n  pass: hunter4", "hunter4"],
    ["json api-key", '{"api-key": "raw5"}', "raw5"],
    ["json X-Api-Key", '{"X-Api-Key": "raw6"}', "raw6"],
    ["ghp after _", "MY_ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", "aBcDeFgH"],
    ["anthropic", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789-ABCDEFGHIJ", "abcdefghijklmnop"],
    ["openai project", "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG", "abcdefghijklmnop"],
    ["sentry org token", "sntrys_eyJpYXQiOjE2ODAwMDAwMDAuMCwidXJsIjoiaHR0cHM6Ly9zZW50cnkuaW8ifQ==_abcdef", "eyJpYXQi"],
    ["sentry user token", "sntryu_0123456789abcdef0123456789abcdef0123456789abcdef", "0123456789abcdef"],
    ["google", "AIzaSyA1234567890abcdefghijklmnopqrstuv", "SyA123"],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjg"],
    ["github", "token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789", "aBcDeFgH"],
    ["github fine-grained", "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789", "11ABCDEFG"],
  ];

  it.each(leaks)("redacts %s", (_name, input, secret) => {
    expect(scrubSecrets(input)).not.toContain(secret);
  });

  it("redacts numbers under credential keys in structured values", () => {
    const out = scrubValue({ password: 123456789, pin: 1, env: { DB_PASS: "rawD", STRIPE_KEY: "rawC" } }, 4_000);
    expect(out).not.toContain("123456789");
    expect(out).not.toContain("rawD");
    expect(out).not.toContain("rawC");
    expect(out).toContain('"pin":1');
    expect(scrubValue({ headers: { "X-Api-Key": "rawA", "api-key": "rawB" } }, 4_000)).not.toMatch(/rawA|rawB/);
  });

  it("leaves ordinary prose and code mostly alone", () => {
    const kept = [
      "Press any key on the keyboard to continue",
      "Bring your passport and a monkey wrench",
      "const key = map.get(k);",
      "for key in items: print(key)",
      "The password reset flow is described below.",
      "bypass=true compass=north passthrough=1",
      "primary_key=id sort_key=created_at cache_key=abc public_key=ssh-ed25519",
      "OLDPWD is set by the shell",
      "http://localhost:3000/@vite/client",
      "https://example.com:8443/path/to@x",
      "docker run -u 1000:1000 image",
      "mysql --version; ls -p dir",
      "max_tokens=100 author=ada",
      '{"key": "ENG-123", "name": "x"}',
      '{"url":"http://host:abc","email":"a@b.com"}',
      "Basic information is in the README",
    ];
    for (const text of kept) expect(scrubSecrets(text)).toBe(text);
  });
});

describe("scrubber speed", () => {
  const N = 32_000;
  const rep = (piece: string) => piece.repeat(Math.ceil(N / piece.length)).slice(0, N);
  it.each([
    ["a.", rep("a.")],
    ["quote TOKEN", `"${rep("TOKEN")}`],
    ["quotes TOKEN", rep('"TOKEN')],
    ["TOKEN word", rep("TOKEN")],
    ["TOKEN word with end", `${rep("TOKEN")}!`],
    ["a://", rep("a://")],
    ["x://a:", `x://${rep("a:")}`],
    ["a://b:", rep("a://b:")],
    ["a://b:@", `a://b:${rep("@x")}`],
    ["_KEY", rep("A_KEY_")],
    ["PASS", rep("_PASS")],
    ["header", rep("Authorization: ")],
    ["curl", `curl ${rep("-u ")}`],
    ["mysql", `mysql ${rep("-p ")}`],
    ["aws secret", rep("aws_secret ")],
    ["pem begins", rep("-----BEGIN RSA PRIVATE KEY-----\n")],
    ["pem spaces", `-----BEGIN ${" ".repeat(N)}`],
  ])("scrubs adversarial %s in under 50 ms", (_name, input) => {
    scrubSecrets(input.slice(0, 1_000));
    const started = performance.now();
    scrubSecrets(input);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("checks a long credential-like key quickly", () => {
    const started = performance.now();
    scrubValue({ [`"${rep("TOKEN")}`]: "v" }, 4_000);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("provider times", () => {
  it("refuses times far outside milliseconds since the epoch", () => {
    const parse = (start: number) =>
      traceSchema.safeParse({ key: "k", ended: true, spans: [{ key: "a", name: "x", start, end: start }] }).success;
    expect(parse(1_800_000_000_000)).toBe(true);
    expect(parse(1_800_000_000_000.5)).toBe(true);
    expect(parse(1e300)).toBe(false);
    expect(parse(-5)).toBe(false);
  });

  it("writes any time as a plain nanosecond string", () => {
    for (const ms of [1e300, Number.MAX_VALUE, Infinity, NaN, -1, 1_800_000_000_000.6]) {
      expect(nanos(ms)).toMatch(/^\d+$/);
      expect(() => BigInt(nanos(ms))).not.toThrow();
    }
    expect(nanos(1_800_000_000_000)).toBe("1800000000000000000");
  });
});

describe("lone surrogates", () => {
  const emoji = "😀";
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

  it("are never written as an attribute, a name or a status message", () => {
    const span = otlpSpan({
      traceId: "t",
      spanId: "s",
      name: `${"a".repeat(199)}${emoji}`,
      start: 1,
      end: 2,
      attributes: { broken: "a\ud83d b", cut: `${"a".repeat(31_999)}${emoji}` },
      error: { message: `${"a".repeat(499)}${emoji}` },
    });
    expect(JSON.stringify(span)).not.toMatch(/\\ud83d(?!\\ude00)/);
    for (const attribute of span.attributes) {
      if ("stringValue" in attribute.value) expect(attribute.value.stringValue).not.toMatch(lone);
    }
    expect(span.name).not.toMatch(lone);
    expect(span.status.message).not.toMatch(lone);
    expect(attributes({ x: "\udc00" })[0]!.value).toEqual({ stringValue: "\ufffd" });
  });

  it("are not made by a cut", () => {
    const text = emoji.repeat(50);
    for (let max = 1; max < 20; max++) {
      expect(scrub(text, max)).not.toMatch(lone);
      expect(scrubTail(text, max)).not.toMatch(lone);
      expect(scrubLine(text, max)).not.toMatch(lone);
      expect(recap(text, max)).not.toMatch(lone);
      expect(oneLine(text, max)).not.toMatch(lone);
      expect(scrubText(text, max)).not.toMatch(lone);
      expect(scrubValue({ a: text }, max)).not.toMatch(lone);
    }
  });
});

describe("sending to Sentry", () => {
  it("does not follow a redirect, and does not retry one", async () => {
    let asked: RequestInit | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      asked = init;
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } });
    }) as typeof fetch;
    const parsed = parseDsn(DSN);
    if (!parsed.ok) throw new Error("bad DSN");
    const result = await sendSpans(
      parsed.target,
      [otlpSpan({ traceId: "t", spanId: "s", name: "x", start: 1, end: 2, attributes: {} })],
      { pluginVersion: "0" },
      fetchImpl,
    );
    expect(asked?.redirect).toBe("manual");
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.message).toMatch(/redirect/i);
  });

  it("warns about a plain http DSN unless it points at this machine", () => {
    const remote = parseDsn("http://key@sentry.example.com/7");
    expect(remote.ok && remote.warning).toMatch(/plain http/i);
    for (const host of ["localhost", "127.0.0.1", "[::1]", "localhost:9000"]) {
      const local = parseDsn(`http://key@${host}/7`);
      expect(local.ok && local.warning).toBeFalsy();
    }
    const secure = parseDsn(DSN);
    expect(secure.ok && secure.warning).toBeFalsy();
  });
});
