/**
 * Compatibility with every bb agent provider, not just one. The fixtures are
 * the shapes real threads record (Claude Code, Codex, OpenCode, Antigravity,
 * Grok), with every prompt, path, label and id replaced by a placeholder.
 */
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { OtlpSpan } from "../src/core/otlp.js";
import { TraceBuilder, unwrapCommand } from "../src/core/trace/builder.js";
import { TRACE_EVENT_TYPES, type Span, type TraceEvent, type Turn } from "../src/core/trace/types.js";
import { costDelta, parseRawUsage, readCost, toSentryUsage, type RawUsage } from "../src/core/usage.js";
import { genAiProvider, modelName, turnSpans, type TurnUsage } from "../src/export/spans.js";
import { parseProviders } from "../src/integrations/providers/client.js";
import { createPlugin } from "../src/server.js";
import type { ThreadInfo } from "../src/thread.js";
import { attr, DSN, fakeFetch } from "./helpers.js";

const T0 = 1_800_000_000_000;

/** Events at fixed times, as bb stores them: thread-scoped when no turn is given. */
function events(rows: Array<[at: number, type: string, data: unknown, turnId?: string]>): TraceEvent[] {
  return rows.map(([at, type, data, turnId], index) => ({
    seq: index + 1,
    createdAt: T0 + at,
    type,
    scope: turnId ? { kind: "turn", turnId } : { kind: "thread" },
    data,
  }));
}

function fold(rows: TraceEvent[], content = false): Turn[] {
  const builder = new TraceBuilder({ content });
  builder.apply(rows);
  return builder.snapshot(T0 + 10_000_000);
}

function only<T>(items: readonly T[], what: string): T {
  if (items.length !== 1 || items[0] === undefined) throw new Error(`expected one ${what}, got ${items.length}`);
  return items[0];
}

function spanById(turn: Turn, id: string): Span {
  return only(turn.spans.filter((span) => span.id === id), `span ${id}`);
}

function thread(providerId: string): ThreadInfo {
  return {
    id: "thr_example",
    title: null,
    projectId: "proj_example",
    providerId,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: null,
    environmentId: null,
    hostId: null,
    isWorktree: null,
    branch: null,
  };
}

function otlp(turn: Turn, providerId: string, usage = new Map<string, TurnUsage>()): OtlpSpan[] {
  return turnSpans(turn, { thread: thread(providerId), captureContent: false, now: T0 + 10_000_000, trace: null, usage });
}

const millis = (span: OtlpSpan) => Number((BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n);
const named = (spans: OtlpSpan[], name: string) => only(spans.filter((span) => span.name === name), name);

const request = (model: string) => ({
  requestId: "creq_1",
  initiator: "user",
  source: "spawn",
  input: [{ type: "text", text: "PROMPT" }],
  execution: { model, reasoningLevel: "high", permissionMode: "auto" },
});
const opening = (model: string): Array<[number, string, unknown, string?]> => [
  [0, "client/turn/requested", request(model)],
  [10, "turn/started", { providerThreadId: "p" }, "t1"],
  [20, "turn/input/accepted", { clientRequestId: "creq_1" }, "t1"],
];
const presentation = (detail?: string) => ({
  label: { pending: "Launching subagent", completed: "Launched subagent" },
  icon: { glyph: "UserRound" },
  title: "LABEL",
  ...(detail === undefined ? {} : { detail }),
});

/**
 * Claude Code today: a background `delegation` row whose call returns at
 * once (`item/delegation/completed`, thread-scoped), an agent task that ends
 * when the agent does, and the agent's own items pointing at the row.
 */
function claudeCodeDelegation(detail = "general-purpose agent"): TraceEvent[] {
  const delegation = { type: "delegation", id: "i1", childRef: "toolu_1", label: "LABEL", background: true };
  const task = { type: "backgroundTask", id: "i2", familyId: "f1", taskType: "local_agent", description: "LABEL", skipTranscript: false, foreground: false, parentToolCallId: "i1" };
  return events([
    ...opening("claude-opus-5-5[1m]"),
    [1_000, "item/started", { item: { ...delegation, status: "pending", presentation: presentation(detail) } }, "t1"],
    [1_100, "item/started", { item: { ...task, status: "pending", taskStatus: "running" } }, "t1"],
    [1_112, "item/delegation/completed", { item: { ...delegation, status: "completed", summary: "SUMMARY" } }],
    [2_000, "item/started", { item: { type: "commandExecution", id: "i3", command: "COMMAND", status: "pending", parentToolCallId: "i1" } }, "t1"],
    [2_500, "item/completed", { item: { type: "commandExecution", id: "i3", command: "COMMAND", status: "completed", exitCode: 0, parentToolCallId: "i1" } }, "t1"],
    [3_000, "item/completed", { item: { type: "reasoning", id: "i4", summary: [], content: ["THOUGHT"], parentToolCallId: "i1" } }, "t1"],
    [4_000, "turn/completed", { status: "completed" }, "t1"],
    [480_000, "item/backgroundTask/progress", { item: { ...task, status: "completed", taskStatus: "completed", usage: { totalTokens: 158_296 } } }],
    [480_000, "item/backgroundTask/completed", { item: { ...task, status: "completed", taskStatus: "completed", usage: { totalTokens: 159_194 } } }],
  ]);
}

describe("Claude Code delegation rows", () => {
  it("reads delegation events, which the SDK lists", () => {
    expect(TRACE_EVENT_TYPES).toContain("item/delegation/progress");
    expect(TRACE_EVENT_TYPES).toContain("item/delegation/completed");
  });

  it("ends the handoff when its call returns and the agent when its task does", () => {
    const turn = only(fold(claudeCodeDelegation()), "turn");
    const agent = spanById(turn, "i1");
    expect(agent).toMatchObject({ kind: "subagent", toolName: "Agent", agent: "general-purpose", background: true, tokens: 159_194, status: "completed" });
    expect(agent.callEnd! - agent.start).toBe(112);
    expect(agent.end! - agent.start).toBe(479_000);
    expect(spanById(turn, "i3").parentId).toBe("i1");
    expect(only(turn.activity, "activity").lane).toBe("i1");

    const spans = otlp(turn, "claude-code");
    const call = named(spans, "execute_tool Agent");
    const run = named(spans, "invoke_agent general-purpose");
    expect(millis(call)).toBe(112);
    expect(millis(run)).toBe(479_000);
    expect(attr(call, "gen_ai.transfer.target.name")).toBe("general-purpose");
    expect(run.parentSpanId).toBe(call.spanId);
    expect(attr(named(spans, "execute_tool shell"), "gen_ai.agent.name")).toBe("general-purpose");
    expect(JSON.stringify(spans)).not.toMatch(/LABEL|SUMMARY|COMMAND|THOUGHT|PROMPT/);
  });

  it("keeps a delegation running through its progress events", () => {
    const delegation = { type: "delegation", id: "i1", childRef: "toolu_1", label: "LABEL", background: true };
    const turn = only(
      fold(
        events([
          ...opening("claude-opus-5-5"),
          [1_000, "item/started", { item: { ...delegation, status: "pending", presentation: presentation() } }, "t1"],
          [2_000, "item/delegation/progress", { item: { ...delegation, status: "pending" } }],
          [3_000, "item/delegation/completed", { item: { ...delegation, status: "failed" } }],
          [4_000, "turn/completed", { status: "completed" }, "t1"],
        ]),
      ),
      "turn",
    );
    expect(spanById(turn, "i1")).toMatchObject({ status: "failed", end: T0 + 3_000, callEnd: T0 + 3_000, agent: "subagent" });
  });

  it.each([
    ["Explore agent · model haiku", "Explore"],
    ["pr-review-toolkit:code-reviewer agent", "pr-review-toolkit:code-reviewer"],
    // Grok puts the bare kind there.
    ["general-purpose", "general-purpose"],
    ["model haiku", "subagent"],
    ["a team of agents", "subagent"],
    ["../../etc/passwd agent", "subagent"],
  ])("reads the kind from the detail line %j", (detail, kind) => {
    const turn = only(fold(claudeCodeDelegation(detail)), "turn");
    expect(spanById(turn, "i1").agent).toBe(kind);
  });
});

describe("subagents by shape", () => {
  it("nests a forked Skill's agent under the Skill call", () => {
    const skill = { type: "toolCall", id: "i1", tool: "Skill", arguments: { skill: "code-review", args: "ARGS" } };
    const task = { type: "backgroundTask", id: "i2", familyId: "f1", taskType: "local_agent", description: "/code-review", skipTranscript: true, foreground: true, parentToolCallId: "i1" };
    const turn = only(
      fold(
        events([
          ...opening("claude-opus-5-5"),
          [1_000, "item/started", { item: { ...skill, status: "pending" } }, "t1"],
          [1_001, "item/started", { item: { ...task, status: "pending", taskStatus: "running" } }, "t1"],
          [2_000, "item/started", { item: { type: "fileRead", id: "i3", path: "/PATH", status: "pending", parentToolCallId: "i1" } }, "t1"],
          [2_100, "item/completed", { item: { type: "fileRead", id: "i3", path: "/PATH", status: "completed", parentToolCallId: "i1" } }, "t1"],
          [90_000, "item/backgroundTask/completed", { item: { ...task, status: "completed", taskStatus: "completed" } }],
          [90_010, "item/completed", { item: { ...skill, status: "completed", result: "RESULT" } }, "t1"],
          [91_000, "turn/completed", { status: "completed" }, "t1"],
        ]),
      ),
      "turn",
    );
    expect(spanById(turn, "i1")).toMatchObject({ kind: "subagent", toolName: "Skill", agent: "code-review", end: T0 + 90_010 });
    expect(spanById(turn, "i3").parentId).toBe("i1");
    const spans = otlp(turn, "claude-code");
    expect(named(spans, "invoke_agent code-review").parentSpanId).toBe(named(spans, "execute_tool Skill").spanId);
    expect(attr(named(spans, "execute_tool Read"), "gen_ai.agent.name")).toBe("code-review");
  });

  it("does not take a command's own background task for an agent", () => {
    const command = { type: "commandExecution", id: "i1", command: "COMMAND" };
    const turn = only(
      fold(
        events([
          ...opening("claude-opus-5-5"),
          [1_000, "item/started", { item: { ...command, status: "pending" } }, "t1"],
          [1_010, "item/started", { item: { type: "backgroundTask", id: "i2", taskType: "local_bash", status: "pending", parentToolCallId: "i1" } }, "t1"],
          [1_020, "item/completed", { item: { ...command, status: "completed" } }, "t1"],
          [2_000, "turn/completed", { status: "completed" }, "t1"],
        ]),
      ),
      "turn",
    );
    expect(spanById(turn, "i1").kind).toBe("command");
    expect(spanById(turn, "i2").parentId).toBeNull();
  });

  it("finds a subagent whose turn points at a tool of any name, even before the call", () => {
    const call = { type: "toolCall", id: "i1", tool: "spawn_helper", arguments: { agent: "planner", prompt: "PROMPT" } };
    const turn = only(
      fold(
        events([
          ...opening("some-model"),
          [900, "turn/started", { parentToolCallId: "i1" }, "sub"],
          [1_000, "item/started", { item: { ...call, status: "pending" } }, "t1"],
          [1_500, "item/started", { item: { type: "commandExecution", id: "i2", command: "COMMAND", status: "pending" } }, "sub"],
          [1_600, "item/completed", { item: { type: "commandExecution", id: "i2", command: "COMMAND", status: "completed" } }, "sub"],
          [1_700, "turn/completed", { status: "completed" }, "sub"],
          [1_800, "item/completed", { item: { ...call, status: "completed" } }, "t1"],
          [2_000, "turn/completed", { status: "completed" }, "t1"],
        ]),
      ),
      "turn",
    );
    expect(spanById(turn, "i1")).toMatchObject({ kind: "subagent", toolName: "spawn_helper", agent: "planner" });
    expect(spanById(turn, "i2").parentId).toBe("i1");
  });

  it("knows Antigravity's invoke_subagent by name, its kind by TypeName", () => {
    const call = { type: "toolCall", id: "i1", tool: "invoke_subagent", arguments: { Prompt: "PROMPT", Role: "ROLE Reviewer", TypeName: "research" } };
    const turn = only(
      fold(
        events([
          ...opening("gemini-4-neon"),
          [1_000, "item/started", { item: { ...call, status: "pending" } }, "t1"],
          [2_267, "item/completed", { item: { ...call, status: "completed" } }, "t1"],
          [3_000, "turn/completed", { status: "completed" }, "t1"],
        ]),
      ),
      "turn",
    );
    expect(spanById(turn, "i1")).toMatchObject({ kind: "subagent", agent: "research", callEnd: T0 + 2_267 });
    expect(JSON.stringify(otlp(turn, "acp-antigravity"))).not.toMatch(/ROLE|PROMPT/);
  });

  it("takes OpenCode's lowercase task for a subagent only with a subagent_type", () => {
    const turns = fold(
      events([
        ...opening("opencode/deepseek-v4.1-flash-free"),
        [1_000, "item/started", { item: { type: "toolCall", id: "i1", tool: "task", arguments: { description: "LABEL", prompt: "PROMPT", subagent_type: "explore" }, status: "pending" } }, "t1"],
        [1_100, "item/completed", { item: { type: "toolCall", id: "i1", tool: "task", arguments: {}, status: "completed" } }, "t1"],
        [1_200, "item/started", { item: { type: "toolCall", id: "i2", tool: "task", arguments: { title: "TITLE" }, status: "pending" } }, "t1"],
        [1_300, "item/completed", { item: { type: "toolCall", id: "i2", tool: "task", arguments: {}, status: "completed" } }, "t1"],
        [2_000, "turn/completed", { status: "completed" }, "t1"],
      ]),
    );
    const turn = only(turns, "turn");
    expect(spanById(turn, "i1")).toMatchObject({ kind: "subagent", agent: "explore" });
    expect(spanById(turn, "i2").kind).toBe("tool");
  });

  it("refuses a kind with a path or spaces in it", () => {
    const turn = only(
      fold(
        events([
          ...opening("claude-opus-5-5"),
          [1_000, "item/started", { item: { type: "toolCall", id: "i1", tool: "Agent", arguments: { subagent_type: "team/secret-project" }, status: "pending" } }, "t1"],
          [1_100, "item/completed", { item: { type: "toolCall", id: "i1", tool: "Agent", arguments: {}, status: "completed" } }, "t1"],
          [2_000, "turn/completed", { status: "completed" }, "t1"],
        ]),
      ),
      "turn",
    );
    expect(spanById(turn, "i1").agent).toBe("subagent");
  });
});

describe("unwrapCommand", () => {
  it.each([
    ["/bin/zsh -lc 'git status'", "git status"],
    ['/bin/bash -lc "npm test"', "npm test"],
    ["bash -lc 'ls -la'", "ls -la"],
    ["sh -c 'echo hi'", "echo hi"],
    ["zsh -c make", "make"],
    ['powershell -NoProfile -Command "Get-ChildItem"', "Get-ChildItem"],
    ["pwsh -Command Get-Date", "Get-Date"],
    ['powershell.exe -ExecutionPolicy Bypass -Command "Get-Item ."', "Get-Item ."],
    ['cmd /c "dir /b"', "dir /b"],
    ["cmd.exe /C dir", "dir"],
    ["git status", "git status"],
    ["bash script.sh", "bash script.sh"],
  ])("unwraps %j", (command, inner) => {
    expect(unwrapCommand(command)).toBe(inner);
  });

  it("unwraps a command given as words", () => {
    expect(unwrapCommand(["/bin/zsh", "-lc", "git status"])).toBe("git status");
    expect(unwrapCommand(["pwsh", "-NoProfile", "-Command", "Get-Date"])).toBe("Get-Date");
    expect(unwrapCommand(["git", "status"])).toBe("git status");
  });

  it("changes only what is captured, never the tool name", () => {
    const command = { type: "commandExecution", id: "i1", command: "/bin/zsh -lc 'npm test'" };
    const rows = events([
      ...opening("gpt-6.2-sol"),
      [1_000, "item/started", { item: { ...command, status: "pending" } }, "t1"],
      [1_100, "item/completed", { item: { ...command, status: "completed", exitCode: 0 } }, "t1"],
      [2_000, "turn/completed", { status: "completed" }, "t1"],
    ]);
    expect(spanById(only(fold(rows, false), "turn"), "i1")).toMatchObject({ toolName: "shell", name: "shell", args: null });
    expect(spanById(only(fold(rows, true), "turn"), "i1")).toMatchObject({ toolName: "shell", name: "npm", args: "npm test" });
  });
});

describe("token usage conventions", () => {
  const raw = (value: Record<string, number>): RawUsage => parseRawUsage(value)!;
  // Real totals: Claude Code leaves its cache out of input, Codex counts it in.
  const claude = raw({ totalTokens: 12_496_491, inputTokens: 76, cachedInputTokens: 12_429_294, cacheReadInputTokens: 12_324_490, cacheWriteInputTokens: 104_804, outputTokens: 67_121, reasoningOutputTokens: 0 });
  const codex = raw({ totalTokens: 13_383_698, inputTokens: 13_344_292, cachedInputTokens: 13_086_720, cacheReadInputTokens: 13_086_720, cacheWriteInputTokens: 0, outputTokens: 39_406, reasoningOutputTokens: 6_962 });

  it("adds Claude Code's cache to its input", () => {
    for (const providerId of ["claude-code", null]) {
      expect(toSentryUsage(claude, providerId)).toEqual({
        inputTokens: 12_429_370,
        outputTokens: 67_121,
        totalTokens: 12_496_491,
        cacheReadTokens: 12_324_490,
        cacheWriteTokens: 104_804,
        reasoningTokens: 0,
      });
    }
  });

  it("keeps Codex's input, which already holds its cache and reasoning", () => {
    for (const providerId of ["codex", null]) {
      expect(toSentryUsage(codex, providerId)).toEqual({
        inputTokens: 13_344_292,
        outputTokens: 39_406,
        totalTokens: 13_383_698,
        cacheReadTokens: 13_086_720,
        cacheWriteTokens: 0,
        reasoningTokens: 6_962,
      });
    }
  });

  it("lets a known provider decide where the total cannot", () => {
    // A stretch whose total is unknown, as after a provider restarts its count.
    const noTotal = raw({ inputTokens: 1_000, cachedInputTokens: 600, outputTokens: 50 });
    expect(toSentryUsage(noTotal, "claude-code").inputTokens).toBe(1_600);
    expect(toSentryUsage(noTotal, "codex").inputTokens).toBe(1_000);
    // Ambiguous with no provider to go by: the input is taken to hold its cache.
    expect(toSentryUsage(noTotal, "pi").inputTokens).toBe(1_000);
  });

  it("knows a cache larger than the input cannot be part of it", () => {
    const split = raw({ inputTokens: 10, cachedInputTokens: 0, cacheReadInputTokens: 900, cacheWriteInputTokens: 100, outputTokens: 5 });
    expect(toSentryUsage(split, null)).toMatchObject({ inputTokens: 1_010, cacheReadTokens: 900, cacheWriteTokens: 100 });
    const cached = raw({ inputTokens: 10, cachedInputTokens: 1_000, outputTokens: 5 });
    expect(toSentryUsage(cached, "codex").inputTokens).toBe(1_010);
  });
});

describe("ACP cost", () => {
  it("reads OpenCode's running cost in USD only", () => {
    const update = (cost: unknown) => ({ contextWindowUsage: { usedTokens: 81_191, modelContextWindow: 1_048_576, estimated: false, cost } });
    expect(readCost(update({ amount: 0.42, currency: "USD" }))).toBe(0.42);
    expect(readCost(update({ amount: 0.42, currency: "EUR" }))).toBeNull();
    expect(readCost(update(undefined))).toBeNull();
    expect(costDelta(0.5, 0.2)).toBeCloseTo(0.3);
    expect(costDelta(0.5, null)).toBe(0.5);
    expect(costDelta(0.1, 0.5)).toBeNull();
  });

  it("sends a provider's cost only where there are no tokens", () => {
    const rows = events([...opening("opencode/glm-5.3-flash"), [5_000, "turn/completed", { status: "completed" }, "t1"]]);
    const turn = only(fold(rows), "turn");
    const costOnly = new Map<string, TurnUsage>([["t1", { usage: null, turns: 1, costUsd: 0.0123 }]]);
    const chat = named(otlp(turn, "acp-opencode", costOnly), "chat opencode/glm-5.3-flash");
    expect(attr(chat, "gen_ai.cost.total_tokens")).toBe(0.0123);
    expect(attr(chat, "gen_ai.usage.input_tokens")).toBeUndefined();

    const usage = toSentryUsage(parseRawUsage({ totalTokens: 15, inputTokens: 10, outputTokens: 5 })!);
    const both = new Map<string, TurnUsage>([["t1", { usage, turns: 1, costUsd: 0.0123 }]]);
    const priced = named(otlp(turn, "acp-opencode", both), "chat opencode/glm-5.3-flash");
    expect(attr(priced, "gen_ai.cost.total_tokens")).toBeUndefined();
    expect(attr(priced, "gen_ai.usage.input_tokens")).toBe(10);
  });
});

describe("model and vendor names", () => {
  it.each([
    ["acp-opencode", "zai-coding-plan/glm-5.3", "zai-coding-plan"],
    ["acp-opencode", "opencode/deepseek-v4.1-flash-free", "deepseek"],
    ["acp-opencode", "opencode/beam-free", "opencode"],
    ["acp-opencode", "google/some-model", "gcp.gemini"],
    ["acp-antigravity", "gemini-4-neon", "gcp.gemini"],
    ["acp-grok", "grok-4.7", "x_ai"],
    ["codex", "gpt-6.2-sol", "openai"],
    ["claude-code", "claude-opus-5-5", "anthropic"],
    ["claude-code", "opus", "anthropic"],
    ["pi", "local-model", "pi"],
    ["pi", null, "pi"],
  ])("names %s's %s as %s", (providerId, model, vendor) => {
    expect(genAiProvider(providerId, model)).toBe(vendor);
  });

  it("drops a context window suffix from the model id", () => {
    expect(modelName("claude-opus-4-6[1m]")).toBe("claude-opus-4-6");
    expect(modelName("gpt-6.2-sol")).toBe("gpt-6.2-sol");
    expect(modelName("")).toBeNull();
  });

  it("reports the requested model as the response model unless bb saw a fallback", () => {
    const turn = only(fold(claudeCodeDelegation()), "turn");
    const spans = otlp(turn, "claude-code");
    const root = named(spans, "invoke_agent claude-code");
    expect(attr(root, "gen_ai.request.model")).toBe("claude-opus-5-5");
    expect(attr(root, "gen_ai.response.model")).toBe("claude-opus-5-5");
    for (const chat of spans.filter((span) => span.name.startsWith("chat "))) {
      expect(chat.name).toBe("chat claude-opus-5-5");
      expect(attr(chat, "gen_ai.response.model")).toBe("claude-opus-5-5");
    }
  });
});

describe("trace providers setting", () => {
  it("asks none when empty", () => {
    expect(parseProviders("", "sentry-traces")).toEqual([]);
    expect(parseProviders(" , ", "sentry-traces")).toEqual([]);
  });

  it("asks none by default", async () => {
    const rpc = vi.fn(async () => {
      throw new Error("no plugin should be asked");
    });
    const { bb, harness } = createFakePluginHost({
      pluginId: "sentry-traces",
      settings: { dsn: DSN, enabled: true },
      sdk: { plugins: { callRpc: rpc } },
    });
    await createPlugin({ fetch: fakeFetch().fetchImpl })(bb);
    try {
      const status = await harness.behavior.runCli(["status"]);
      expect(status.stdout).toContain("Trace providers: none");
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
