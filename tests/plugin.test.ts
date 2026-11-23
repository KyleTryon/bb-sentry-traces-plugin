import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlugin } from "../src/server.js";
import { providerSpanId, providerTraceId } from "../src/integrations/providers/spans.js";
import {
  workflowCallSpanId,
  workflowRootSpanId,
  workflowTraceId,
} from "../src/integrations/workflows/ids.js";
import { attr, DSN, eventsList, fakeFetch, History, SECRETS } from "./helpers.js";

const THREAD = "thr_one";

/** An element an indexed read must have: when it is missing, the test fails and names `label`. */
function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label}`);
  return value;
}

const CLAUDE_TOTAL = {
  totalTokens: 11_000,
  inputTokens: 100,
  cachedInputTokens: 10_000,
  cacheReadInputTokens: 9_000,
  cacheWriteInputTokens: 1_000,
  outputTokens: 900,
  reasoningOutputTokens: 0,
};

interface Setup {
  settings?: Record<string, string | boolean>;
  respond?: () => number | Error;
  /** What the Workflows plugin holds: worker threads' metadata and the run view. */
  workflows?: {
    metadata: Record<string, Record<string, unknown>>;
    view: () => unknown;
  };
  /** Fields of bb's thread record, by thread id. */
  threads?: Record<string, Record<string, unknown>>;
  /** Reading Workflows metadata fails, as with Workflows removed. */
  metadataFails?: boolean;
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!();
});

/** The caller a plugin's `bb.sdk.plugins.callRpc` would be. */
const asPlugin = (pluginId: string) => ({ experimental_caller: { kind: "plugin" as const, pluginId } });

async function setup(options: Setup = {}) {
  const histories: Record<string, History> = { [THREAD]: new History() };
  const clock = { now: 1_800_000_500_000 };
  const { fetchImpl, sent, spans } = fakeFetch(options.respond);
  // This plugin calls no plugin but Workflows.
  const rpc = vi.fn(async ({ pluginId, method }: { pluginId: string; method: string; input?: unknown }) => {
    if (pluginId === "workflows" && options.workflows && method === "workflowRunView") {
      return { run: options.workflows.view() };
    }
    throw new Error(`plugin ${pluginId} has no method ${method}`);
  });
  const thread = (id: string) =>
    makeThreadResponse({
      id,
      title: SECRETS.title,
      providerId: "claude-code",
      projectId: "proj_1",
      ...options.threads?.[id],
    });
  const { bb, harness } = createFakePluginHost({
    pluginId: "sentry-traces",
    settings: { dsn: DSN, enabled: true, ...options.settings },
    sdk: {
      threads: {
        events: { list: eventsList(histories) },
        get: async ({ threadId }: { threadId: string }) => {
          if (!histories[threadId]) throw new Error("not found");
          return thread(threadId);
        },
        getPluginMetadata: async ({ threadId }: { threadId: string }) => {
          if (options.metadataFails) throw new Error("plugin workflows is not installed");
          return options.workflows?.metadata[threadId] ?? {};
        },
      },
      plugins: { callRpc: rpc },
    },
  });
  await createPlugin({ fetch: fetchImpl, now: () => clock.now })(bb);
  disposers.push(() => harness.lifecycle.dispose());

  /** Fires the event and waits until the export it started has settled. */
  const emit = async (event: "thread.idle" | "thread.failed" | "thread.active", id = THREAD) => {
    const before = harness.inspection.sdk.calls.length;
    if (event === "thread.idle") {
      await harness.behavior.emitThreadEvent(event, { thread: thread(id), lastAssistantText: null });
    } else if (event === "thread.failed") {
      await harness.behavior.emitThreadEvent(event, { thread: thread(id), error: null });
    } else {
      await harness.behavior.emitThreadEvent(event, { thread: thread(id) });
    }
    // The handler returns at once; give the queued export time to finish.
    for (let quiet = 0, last = -1; quiet < 3; ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const calls = harness.inspection.sdk.calls.length + sent.length;
      quiet = calls === last ? quiet + 1 : 0;
      last = calls;
    }
    return harness.inspection.sdk.calls.length - before;
  };
  const tick = async () => {
    const service = harness.behavior.runService("export-retry");
    service.controller.abort();
    await service.done;
  };
  /** A provider claims threads for its traces, or clears its claim with null. */
  const claim = (threads: Record<string, unknown>, provider = P) =>
    harness.behavior.callRpc(
      "report_threads",
      { contract: 2, threads: Object.entries(threads).map(([threadId, context]) => ({ threadId, context })) },
      asPlugin(provider),
    ) as Promise<{ contract: number; sending: boolean; results: Record<string, string> }>;
  /** A provider reports a trace's snapshot. */
  const report = (trace: unknown, provider = P) =>
    harness.behavior.callRpc("report_trace", { contract: 2, trace }, asPlugin(provider)) as Promise<{
      contract: number;
      sending: boolean;
    }>;
  /** A provider says a trace no longer exists. */
  const reportDeleted = (key: string, provider = P) =>
    harness.behavior.callRpc("report_trace", { contract: 2, deleted: { key } }, asPlugin(provider));
  const history = must(histories[THREAD], "the thread's history");
  return { bb, harness, histories, history, clock, sent, spans, rpc, emit, tick, claim, report, reportDeleted };
}

const names = (spans: Array<{ name: string }>) => spans.map((span) => span.name);

const P = "example-provider";
const KEY = "run_42";
/** A turn that starts a background subagent which is still working when the turn ends. */
function backgroundTurn(history: History, turnId: string, taskId = `${turnId}-task`) {
  history.request(`${turnId}-req`).start(turnId, `${turnId}-req`);
  const call = {
    type: "toolCall",
    id: `${turnId}-agent`,
    tool: "Agent",
    arguments: { subagent_type: "Explore", run_in_background: true },
  };
  history.push("item/started", { item: { ...call, status: "pending" } }, turnId);
  history.push("turn/started", { parentToolCallId: call.id }, `${turnId}-sub`);
  history.push("item/completed", { item: { ...call, status: "completed" } }, turnId);
  const task = { type: "backgroundTask", id: taskId, taskType: "local_agent", parentToolCallId: call.id };
  history.push("item/backgroundTask/progress", { item: { ...task, status: "pending" } }, turnId);
  history.complete(turnId);
  return () =>
    history.push("item/backgroundTask/completed", {
      item: { ...task, status: "completed", usage: { totalTokens: 99 } },
    });
}
const agentTurns = (spans: Array<{ name: string; attributes: unknown }>) =>
  spans
    .filter((span) => span.name.startsWith("invoke_agent") && attr(span as never, "bb.turn.id"))
    .filter((span) => !span.name.includes("Explore"))
    .map((span) => attr(span as never, "bb.turn.index"));
const turnIndexes = (spans: Array<{ name: string }>) =>
  spans
    .filter((span) => span.name.startsWith("invoke_agent"))
    .map((span) => attr(span as never, "bb.turn.index"));
/** The spans in the OTLP JSON that `bb sentry-traces export` prints. */
function exportedSpans(stdout: string) {
  // A narrow cast at this boundary: the parts of the export these tests read.
  const body = JSON.parse(stdout) as {
    resourceSpans: Array<{
      scopeSpans: Array<{ spans: Array<{ name: string; attributes: Array<{ key: string }> }> }>;
    }>;
  };
  return must(must(body.resourceSpans[0], "resource spans").scopeSpans[0], "scope spans").spans;
}
/** A finished turn of `items` commands. */
function turnOf(h: History, turnId: string, items: number) {
  h.request(`${turnId}-req`).start(turnId, `${turnId}-req`);
  for (let index = 0; index < items; index++) {
    h.item(turnId, { type: "commandExecution", id: `${turnId}-${index}`, command: "ls" }, 1);
  }
  h.complete(turnId);
}

describe("configuration", () => {
  it("says how to clear the notice, and checks a DSN changed later", async () => {
    const { harness } = await setup({ settings: { dsn: "" } });
    expect(harness.inspection.needsConfigurationMessages[0]).toContain("bb plugin reload sentry-traces");
    await harness.behavior.setSettings({ dsn: "not a url" });
    expect(harness.inspection.needsConfigurationMessages.at(-1)).toContain("The DSN is not a URL.");
  });

  it("reports needs-configuration until a DSN is set, and sends nothing", async () => {
    const { harness, history, emit, sent } = await setup({ settings: { dsn: "" } });
    expect(harness.inspection.needsConfigurationMessages[0]).toContain("No DSN is set.");
    history.turn();
    await emit("thread.idle");
    expect(sent).toHaveLength(0);
  });

  it("sends nothing while disabled, and reads no thread", async () => {
    const { harness, history, emit, sent } = await setup({ settings: { enabled: false } });
    history.turn();
    await emit("thread.active");
    await emit("thread.idle");
    expect(sent).toHaveLength(0);
    expect(harness.inspection.sdk.callsTo("threads.events.list")).toHaveLength(0);
  });
});

describe("exporting a thread", () => {
  it("sends a finished turn as one trace of agent, model and tool spans", async () => {
    const { history, emit, sent, spans } = await setup();
    await emit("thread.active");
    history.turn();
    history.usage(CLAUDE_TOTAL);
    await emit("thread.idle");

    expect(sent).toHaveLength(1);
    expect(must(sent[0], "request").url).toContain("/api/4500000000000001/integration/otlp/v1/traces");
    const all = spans();
    expect(new Set(all.map((span) => span.traceId)).size).toBe(1);
    // The chat span that carries the turn's usage goes last.
    expect(names(all)).toEqual([
      "invoke_agent claude-code",
      "chat claude-fable-5-2",
      "chat claude-fable-5-2",
      "execute_tool shell",
      "execute_tool mcp__docs__search",
      "execute_tool Read",
      "chat claude-fable-5-2",
    ]);
    expect(attr(all.at(-1)!, "gen_ai.usage.input_tokens")).toBeDefined();

    const agent = must(all[0], "agent span");
    const rest = all.slice(1);
    expect(agent.parentSpanId).toBeUndefined();
    expect(attr(agent, "sentry.op")).toBe("gen_ai.invoke_agent");
    expect(attr(agent, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(attr(agent, "gen_ai.agent.name")).toBe("claude-code");
    expect(attr(agent, "gen_ai.request.model")).toBe("claude-fable-5-2");
    expect(attr(agent, "gen_ai.provider.name")).toBe("anthropic");
    expect(attr(agent, "gen_ai.request.reasoning.level")).toBe("high");
    for (const span of all) {
      expect(attr(span, "gen_ai.conversation.id")).toBe(THREAD);
      if (span !== agent) expect(span.parentSpanId).toBe(agent.spanId);
    }
    const tool = rest.find((span) => span.name === "execute_tool shell")!;
    expect(attr(tool, "gen_ai.operation.name")).toBe("execute_tool");
    expect(attr(tool, "gen_ai.tool.name")).toBe("shell");
    expect(attr(tool, "process.exit.code")).toBe(0);
    expect(attr(tool, "gen_ai.tool.call.id")).toBe("turn-1-c1");
    const chat = rest.find((span) => span.name.startsWith("chat"))!;
    expect(attr(chat, "gen_ai.operation.name")).toBe("chat");
    expect(attr(chat, "bb.inferred")).toBe(true);
    // bb records no other answering model, so the requested one answered.
    expect(attr(chat, "gen_ai.response.model")).toBe("claude-fable-5-2");
    // OpenTelemetry's kinds: a model request is a client span, the rest internal.
    expect([agent.kind, chat.kind, tool.kind]).toEqual([1, 3, 1]);
  });

  it("puts the turn's token usage on exactly one span, in Sentry's convention", async () => {
    const { history, emit, spans } = await setup();
    await emit("thread.active");
    history.turn();
    history.usage(CLAUDE_TOTAL);
    await emit("thread.idle");

    const withUsage = spans().filter(
      (span) => attr(span, "gen_ai.usage.input_tokens") !== undefined,
    );
    expect(withUsage).toHaveLength(1);
    expect(must(withUsage[0], "span with usage").name).toBe("chat claude-fable-5-2");
    // Input includes the cached tokens Claude Code reports separately.
    expect(attr(must(withUsage[0], "span with usage"), "gen_ai.usage.input_tokens")).toBe(10_100);
    expect(attr(must(withUsage[0], "span with usage"), "gen_ai.usage.cache_read.input_tokens")).toBe(9_000);
    expect(attr(must(withUsage[0], "span with usage"), "gen_ai.usage.cache_creation.input_tokens")).toBe(1_000);
    expect(attr(must(withUsage[0], "span with usage"), "gen_ai.usage.output_tokens")).toBe(900);
    expect(attr(must(withUsage[0], "span with usage"), "gen_ai.usage.total_tokens")).toBe(11_000);
  });

  it("charges each later turn only with what it added", async () => {
    const { history, emit, spans } = await setup();
    await emit("thread.active");
    history.turn();
    history.usage(CLAUDE_TOTAL);
    await emit("thread.idle");
    history.turn();
    history.usage({ ...CLAUDE_TOTAL, totalTokens: 11_700, inputTokens: 300, outputTokens: 1_400 });
    await emit("thread.idle");

    const inputs = spans()
      .map((span) => attr(span, "gen_ai.usage.input_tokens"))
      .filter((value) => value !== undefined);
    expect(inputs).toEqual([10_100, 200]);
  });

  it("does not charge a first exported turn with the history of an older thread", async () => {
    const { history, emit, spans } = await setup();
    history.turn();
    history.turn();
    history.usage(CLAUDE_TOTAL);
    // The plugin never saw this thread start, so it has no total to subtract from.
    await emit("thread.idle");
    expect(names(spans())[0]).toBe("invoke_agent claude-code");
    expect(spans().some((span) => attr(span, "gen_ai.usage.input_tokens") !== undefined)).toBe(
      false,
    );
    // Only the newest turn goes out when the plugin is first turned on.
    expect(spans().filter((span) => span.name.startsWith("invoke_agent"))).toHaveLength(1);
    expect(attr(must(spans()[0], "first span"), "bb.turn.index")).toBe(2);
  });

  it("sends each turn once, and reads only new events the next time", async () => {
    const { harness, history, emit, sent, spans } = await setup();
    history.turn();
    await emit("thread.idle");
    await emit("thread.idle");
    await emit("thread.failed");
    expect(sent).toHaveLength(1);

    history.turn();
    const firstNewSeq = history.events.find((event) => event.type === "client/turn/requested" && event.seq > 3)!.seq;
    await emit("thread.idle");
    expect(sent).toHaveLength(2);
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => attr(span, "bb.turn.index"))).toEqual([1, 2]);
    // Two turns, two traces, one conversation.
    expect(new Set(agents.map((span) => span.traceId)).size).toBe(2);
    expect(new Set(agents.map((span) => span.spanId)).size).toBe(2);

    const reads = harness.inspection.sdk
      .callsTo("threads.events.list")
      .map((args) => (args[0] as { afterSeq?: string }).afterSeq)
      .filter((afterSeq) => afterSeq !== undefined);
    expect(Number(reads.at(-1))).toBe(firstNewSeq - 1);
  });

  it("does not count a queued prompt's wait as startup when the turn before was sent earlier", async () => {
    const { history: h, emit, spans } = await setup();
    h.request("req-1").wait(50).start("t1", "req-1");
    h.wait(1_000).request("req-2");
    h.wait(20_000);
    h.item("t1", { type: "agentMessage", id: "m1", text: "x" }, 100);
    h.complete("t1");
    h.start("t2", "req-2");
    // Exported while the queued turn runs, so the next export begins inside it.
    await emit("thread.idle");
    h.item("t2", { type: "agentMessage", id: "m2", text: "y" }, 100);
    h.complete("t2");
    await emit("thread.idle");
    expect(spans().filter((span) => span.name === "Starting")).toEqual([]);
    const second = must(
      spans().filter((span) => span.name.startsWith("invoke_agent"))[1],
      "second agent span",
    );
    const ms = Number((BigInt(second.endTimeUnixNano) - BigInt(second.startTimeUnixNano)) / 1_000_000n);
    expect(ms).toBeLessThan(1_000);
  });

  it("starts a long thread at its newest turn, not at the end of its first read", async () => {
    const { history: h, emit, spans } = await setup();
    // Ten turns of 2,100 calls each: more events than one export reads at once.
    for (let turn = 1; turn <= 10; turn++) {
      h.request(`req-${turn}`).start(`t${turn}`, `req-${turn}`);
      for (let index = 0; index < 2_100; index++) {
        h.item(`t${turn}`, { type: "commandExecution", id: `t${turn}-c${index}`, command: "ls" }, 1);
      }
      h.complete(`t${turn}`);
    }
    h.turn();
    await emit("thread.idle");
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => attr(span, "bb.turn.index"))).toEqual([11]);
  }, 30_000);

  it("keeps a queued prompt's model for the turn that later runs it", async () => {
    const { history, emit, spans } = await setup();
    history.request("req-a", "first", "model-a").start("turn-a", "req-a");
    // Sent while the first turn is still running.
    history.request("req-b", "second", "model-b");
    history.complete("turn-a");
    await emit("thread.idle");
    history.start("turn-b", "req-b").complete("turn-b");
    await emit("thread.idle");
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => attr(span, "gen_ai.request.model"))).toEqual(["model-a", "model-b"]);
    expect(agents.map((span) => attr(span, "bb.turn.index"))).toEqual([1, 2]);
  });

  it("reports a subagent as a tool call that hands work to another agent", async () => {
    const { history, emit, spans } = await setup();
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
    history.item("sub-turn", { type: "commandExecution", id: "sub-cmd", command: "ls" }, 200);
    history.push("turn/completed", { status: "completed" }, "sub-turn");
    history.push(
      "item/completed",
      { item: { type: "toolCall", id: "agent-1", tool: "Agent", arguments: {}, status: "completed" } },
      "turn-1",
    );
    history.complete("turn-1");
    await emit("thread.idle");

    const root = must(spans()[0], "root span");
    const call = spans().find((span) => span.name === "execute_tool Agent")!;
    const agent = spans().find((span) => span.name === "invoke_agent Explore")!;
    const inner = spans().find((span) => span.name === "execute_tool shell")!;
    // The tool call is the handoff; no separate handoff span exists.
    expect(call.parentSpanId).toBe(root.spanId);
    expect(attr(call, "gen_ai.operation.name")).toBe("execute_tool");
    expect(attr(call, "gen_ai.tool.name")).toBe("Agent");
    expect(attr(call, "gen_ai.tool.call.id")).toBe("agent-1");
    expect(attr(call, "gen_ai.transfer.target.name")).toBe("Explore");
    expect(attr(call, "gen_ai.transfer.mode")).toBe("return_to_caller");
    expect(attr(call, "gen_ai.agent.name")).toBe("claude-code");
    // The target agent's run nests under the call, and its own calls under it.
    expect(agent.parentSpanId).toBe(call.spanId);
    expect(attr(agent, "gen_ai.operation.name")).toBe("invoke_agent");
    expect(attr(agent, "gen_ai.agent.name")).toBe("Explore");
    expect(inner.parentSpanId).toBe(agent.spanId);
    expect(attr(inner, "gen_ai.agent.name")).toBe("Explore");
    expect(attr(inner, "gen_ai.transfer.mode")).toBeUndefined();
    expect(spans().some((span) => attr(span, "sentry.op") === "gen_ai.handoff")).toBe(false);
    expect(JSON.stringify(spans())).not.toContain(SECRETS.label);
  });

  it("keeps gen_ai attributes off spans that are not agent, model or tool spans", async () => {
    const { history, emit, spans } = await setup();
    history.request("req-1");
    // A slow start becomes a startup span.
    history.wait(2_000).start("turn-1", "req-1");
    history.push(
      "system/interaction/lifecycle",
      { interaction: { id: "q1", status: "pending", payload: { kind: "user_question" } } },
      "turn-1",
    );
    history.wait(5_000);
    history.push(
      "system/interaction/lifecycle",
      { interaction: { id: "q1", status: "resolved", payload: { kind: "user_question" } } },
      "turn-1",
    );
    history.complete("turn-1");
    await emit("thread.idle");
    const others = spans().filter((span) => !String(attr(span, "sentry.op")).startsWith("gen_ai."));
    expect(names(others)).toEqual(["Starting", "wait Question"]);
    for (const span of others) {
      expect(attr(span, "gen_ai.agent.name")).toBeUndefined();
      expect(attr(span, "gen_ai.operation.name")).toBeUndefined();
      // Sentry shows no description for these unless one is sent.
      expect(attr(span, "sentry.description")).toBe(span.name);
      expect(attr(span, "gen_ai.conversation.id")).toBe(THREAD);
    }
  });

  it("marks a failed turn and failed tool calls as errors", async () => {
    const { history, emit, spans } = await setup();
    history.request("req-1").start("turn-1", "req-1");
    history.item("turn-1", { type: "commandExecution", id: "c1", command: "false" }, 100, {
      status: "failed",
      exitCode: 2,
      error: SECRETS.toolError,
    });
    history.complete("turn-1", "failed", "overloaded_error");
    await emit("thread.failed");
    const agent = must(spans()[0], "agent span");
    expect(agent.status).toEqual({ code: 2, message: "overloaded_error" });
    const tool = spans().find((span) => span.name === "execute_tool shell")!;
    expect(tool.status.code).toBe(2);
    expect(attr(tool, "error.type")).toBe("tool_error");
    expect(attr(tool, "process.exit.code")).toBe(2);
    expect(JSON.stringify(tool)).not.toContain(SECRETS.toolError);
  });

  it("sends the newest turn of a long thread when the read ends right after it", async () => {
    const { history: h, emit, spans } = await setup();
    // 4 + 2 × 19,998 = 40,000 events: exactly one read, ending at the turn's end.
    h.request("req-1").start("t1", "req-1");
    for (let index = 0; index < 19_998; index++) {
      h.item("t1", { type: "commandExecution", id: `c${index}`, command: "ls" }, 1);
    }
    h.complete("t1");
    for (let index = 0; index < 5; index++) {
      h.push("thread/contextWindowUsage/updated", { contextWindowUsage: { usedTokens: index } });
    }
    await emit("thread.idle");
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => attr(span, "bb.turn.id"))).toEqual(["t1"]);
  }, 30_000);

  it.each(["local_agent", "local_subagent"])(
    "waits for a background subagent (%s) that outlives its turn, then sends its real end",
    async (taskType) => {
      const { bb, history, emit, tick, clock, spans } = await setup();
      history.request("req-1").start("turn-1", "req-1");
      const agentCall = {
        type: "toolCall",
        id: "agent-1",
        tool: "Agent",
        arguments: { subagent_type: "Explore", run_in_background: true },
      };
      history.push("item/started", { item: { ...agentCall, status: "pending" } }, "turn-1");
      history.push("turn/started", { parentToolCallId: "agent-1" }, "sub-turn");
      history.push("item/completed", { item: { ...agentCall, status: "completed" } }, "turn-1");
      const task = { type: "backgroundTask", id: "task-1", taskType, parentToolCallId: "agent-1" };
      history.push("item/backgroundTask/progress", { item: { ...task, status: "pending" } }, "turn-1");
      history.complete("turn-1");
      await emit("thread.idle");
      expect(spans()).toHaveLength(0);
      expect(await bb.storage.kv.get(`retry:${THREAD}`)).toMatchObject({ attempts: 0 });

      history.wait(60_000);
      history.item("sub-turn", { type: "commandExecution", id: "sub-cmd", command: "ls" }, 200);
      history.push("turn/completed", { status: "completed" }, "sub-turn");
      const done = history.push("item/backgroundTask/completed", {
        item: { ...task, status: "completed", usage: { totalTokens: 1_234 } },
      });
      clock.now += 20 * 60_000;
      await tick();

      const agent = spans().find((span) => span.name === "invoke_agent Explore")!;
      expect(agent).toBeDefined();
      expect(attr(agent, "bb.span.running")).toBeUndefined();
      expect(attr(agent, "bb.span.status")).toBe("completed");
      expect(attr(agent, "bb.subagent.tokens")).toBe(1_234);
      expect(Number(agent.endTimeUnixNano)).toBe(done.createdAt * 1_000_000);
      expect(spans().some((span) => span.name === "execute_tool Background")).toBe(false);
      expect(await bb.storage.kv.list("retry:")).toEqual([]);
    },
  );

  it("sends a turn whose background subagent never reports back once the wait is over", async () => {
    const { history, emit, tick, clock, spans } = await setup();
    history.request("req-1").start("turn-1", "req-1");
    const agentCall = { type: "toolCall", id: "agent-1", tool: "Agent", arguments: { run_in_background: true } };
    history.push("item/started", { item: { ...agentCall, status: "pending" } }, "turn-1");
    history.push("item/completed", { item: { ...agentCall, status: "completed" } }, "turn-1");
    const task = { type: "backgroundTask", id: "task-1", taskType: "local_agent", parentToolCallId: "agent-1" };
    history.push("item/backgroundTask/progress", { item: { ...task, status: "pending" } }, "turn-1");
    history.complete("turn-1");
    await emit("thread.idle");
    expect(spans()).toHaveLength(0);
    clock.now += 3 * 60 * 60_000;
    await tick();
    const agent = spans().find((span) => span.name === "invoke_agent subagent")!;
    expect(attr(agent, "bb.span.running")).toBe(true);
  });

  it("keeps a long thread's newest turn when it waits after the catch-up read", async () => {
    const { history: h, emit, tick, clock, spans } = await setup();
    // 4 + 2 × 19,991 events, then the 8 of a waiting turn: 39,994, then 10 more.
    h.request("req-1").start("t1", "req-1");
    for (let index = 0; index < 19_991; index++) {
      h.item("t1", { type: "commandExecution", id: `c${index}`, command: "ls" }, 1);
    }
    h.complete("t1");
    const finish = backgroundTurn(h, "t2");
    for (let index = 0; index < 10; index++) {
      h.push("thread/contextWindowUsage/updated", { contextWindowUsage: { usedTokens: index } });
    }
    await emit("thread.idle");
    expect(spans()).toHaveLength(0);
    finish();
    clock.now += 20 * 60_000;
    await tick();
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.filter((span) => attr(span, "bb.turn.id") === "t2")).not.toHaveLength(0);
    expect(agents.some((span) => attr(span, "bb.turn.id") === "t1")).toBe(false);
    const sub = agents.find((span) => span.name === "invoke_agent Explore")!;
    expect(attr(sub, "bb.span.status")).toBe("completed");
  }, 30_000);

  it("reads on past an old turn when a later turn fills the rest of the read", async () => {
    const { history: h, emit, spans } = await setup();
    h.turn();
    // 4 + 2 × 19,990 events: more than the rest of the first read, less than a whole read.
    h.request("req-big").start("big", "req-big");
    for (let index = 0; index < 19_990; index++) {
      h.item("big", { type: "commandExecution", id: `b${index}`, command: "ls" }, 1);
    }
    h.complete("big");
    h.turn();
    await emit("thread.idle");
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => attr(span, "bb.turn.id"))).toEqual(["turn-2"]);
  }, 30_000);

  it("sends the turns after a waiting turn at once, and the waiting turn when it is done", async () => {
    const { history, emit, tick, clock, spans } = await setup();
    const finish = backgroundTurn(history, "slow");
    await emit("thread.idle");
    for (let turn = 0; turn < 30; turn++) {
      history.turn();
      await emit("thread.idle");
    }
    expect(agentTurns(spans())).toEqual(Array.from({ length: 30 }, (_, index) => index + 2));
    finish();
    clock.now += 20 * 60_000;
    await tick();
    const all = agentTurns(spans());
    expect(all).toHaveLength(31);
    expect(new Set(all).size).toBe(31);
    expect(all.at(-1)).toBe(1);
  }, 30_000);

  it("keeps a waiting turn's tokens off the turns sent before it", async () => {
    const { history, emit, tick, clock, spans } = await setup();
    await emit("thread.active");
    history.turn();
    await emit("thread.idle");
    // Two turns go out together; the second waits on its subagent.
    history.turn();
    const finish = backgroundTurn(history, "slow");
    history.usage(CLAUDE_TOTAL);
    await emit("thread.idle");
    const usageOf = () => spans().filter((span) => attr(span, "gen_ai.usage.input_tokens") !== undefined);
    expect(agentTurns(spans())).toEqual([1, 2]);
    expect(usageOf()).toHaveLength(0);

    finish();
    clock.now += 20 * 60_000;
    await tick();
    expect(usageOf()).toHaveLength(1);
    expect(attr(must(usageOf()[0], "span with usage"), "bb.turn.id")).toBe("slow");
    expect(attr(must(usageOf()[0], "span with usage"), "gen_ai.usage.input_tokens")).toBe(10_100);
    expect(attr(must(usageOf()[0], "span with usage"), "bb.usage.turns")).toBe(2);
  });

  it("sends a new thread's first usage when its first export has to be retried", async () => {
    let status = 503;
    const { history, emit, tick, clock, spans } = await setup({ respond: () => status });
    // The thread was never seen starting, and its first prompt is not its first event.
    history.push("thread/started", {});
    history.turn();
    history.usage(CLAUDE_TOTAL);
    await emit("thread.idle");
    expect(spans()).toHaveLength(0);
    status = 200;
    clock.now += 2 * 60_000;
    await tick();
    const withUsage = spans().filter((span) => attr(span, "gen_ai.usage.input_tokens") !== undefined);
    expect(withUsage).toHaveLength(1);
    expect(attr(must(withUsage[0], "span with usage"), "gen_ai.usage.input_tokens")).toBe(10_100);
  });

  it("sends a long thread's newest finished turn when the turn after it never finishes", async () => {
    const { history: h, emit, spans } = await setup();
    h.turn();
    h.request("req-open").start("open", "req-open");
    for (let index = 0; index < 20_000; index++) {
      h.item("open", { type: "commandExecution", id: `o${index}`, command: "ls" }, 1);
    }
    await emit("thread.failed");
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => attr(span, "bb.turn.id"))).toEqual(["turn-1"]);
  }, 30_000);

  it("sends a turn longer than one read, and the turns after it", async () => {
    const { history: h, emit, spans } = await setup();
    h.turn();
    await emit("thread.idle");
    turnOf(h, "long", 20_000);
    h.turn();
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([1, 2, 3]);
    expect(spans().filter((span) => attr(span, "bb.turn.id") === "long").length).toBeGreaterThan(20_000);
  }, 60_000);

  it("starts a thread never sent before at its newest turn, past a turn longer than one read", async () => {
    const { history: h, emit, spans } = await setup();
    h.turn();
    turnOf(h, "long", 20_000);
    h.turn();
    h.turn();
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([4]);
    h.turn();
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([4, 5]);
  }, 60_000);

  it("sends a first turn's usage from a state that never read a total", async () => {
    const { bb, history, emit, spans } = await setup();
    // As left by a first export that failed before this state recorded what it knew.
    await bb.storage.kv.set(`thread:${THREAD}`, {
      sentTurn: 0,
      resumeSeq: 0,
      turnsBefore: 0,
      usage: null,
      usageKnown: false,
      partial: null,
      updatedAt: 0,
    });
    history.turn();
    history.usage(CLAUDE_TOTAL);
    await emit("thread.idle");
    const withUsage = spans().filter((span) => attr(span, "gen_ai.usage.input_tokens") !== undefined);
    expect(withUsage).toHaveLength(1);
    expect(attr(must(withUsage[0], "span with usage"), "gen_ai.usage.input_tokens")).toBe(10_100);
  });

  it("reads on after a turn longer than one read without waiting for the thread's next event", async () => {
    const { bb, history: h, emit, tick, spans } = await setup();
    h.turn();
    await emit("thread.idle");
    turnOf(h, "long", 20_000);
    // Too long to end in the page the long turn ends in.
    turnOf(h, "after", 150);
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([1, 2]);
    await tick();
    expect(turnIndexes(spans())).toEqual([1, 2, 3]);
    expect(await bb.storage.kv.list("retry:")).toEqual([]);
  }, 60_000);

  it("starts a thread never sent before at its newest turn when a long turn ends its read exactly", async () => {
    const { history: h, emit, spans } = await setup();
    h.turn();
    // 4 + 2 × 19,998 events: read from its own start, this turn ends on the read's last
    // event, so the read shows no later turn although one has finished.
    turnOf(h, "long", 19_998);
    // Long enough that the first read, from the thread's start, is cut short too.
    turnOf(h, "after", 150);
    h.turn();
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([4]);
  }, 60_000);
});

describe("content capture", () => {
  it("is off by default: no prompt, reply, command, argument, output, path or title is sent", async () => {
    const { history, emit, sent } = await setup();
    history.turn();
    await emit("thread.idle");
    const body = JSON.stringify(sent);
    for (const secret of Object.values(SECRETS)) expect(body).not.toContain(secret);
  });

  it("sends scrubbed messages and tool content when turned on", async () => {
    const { history, emit, spans } = await setup({ settings: { captureContent: true } });
    history.request("req-1", `${SECRETS.prompt} with ghp_abcdefghijklmnopqrstuvwxyz0123`);
    history.start("turn-1", "req-1");
    history.item(
      "turn-1",
      { type: "commandExecution", id: "c1", command: SECRETS.command },
      100,
      { exitCode: 0, aggregatedOutput: SECRETS.output },
    );
    history.item("turn-1", { type: "agentMessage", id: "m1", text: SECRETS.reply }, 100);
    history.complete("turn-1");
    await emit("thread.idle");

    const agent = must(spans()[0], "agent span");
    const input: unknown = JSON.parse(String(attr(agent, "gen_ai.input.messages")));
    expect(input).toEqual([
      { role: "user", parts: [{ type: "text", content: `${SECRETS.prompt} with [redacted]` }] },
    ]);
    expect(JSON.parse(String(attr(agent, "gen_ai.output.messages")))).toEqual([
      { role: "assistant", parts: [{ type: "text", content: SECRETS.reply }] },
    ]);
    expect(attr(agent, "bb.thread.title")).toBe(SECRETS.title);
    const tool = spans().find((span) => span.name === "execute_tool shell")!;
    expect(attr(tool, "gen_ai.tool.call.arguments")).toBe(SECRETS.command);
    expect(attr(tool, "gen_ai.tool.call.result")).toBe(SECRETS.output);
  });

  it("keeps the end of a long reply and the true size of each cut", async () => {
    const { history, emit, spans } = await setup({ settings: { captureContent: true } });
    history.request("req-1").start("turn-1", "req-1");
    history.item(
      "turn-1",
      { type: "toolCall", id: "t1", tool: "mcp__docs__search", arguments: { query: "q".repeat(6_000) } },
      100,
      { result: "r".repeat(6_000) },
    );
    history.item("turn-1", { type: "agentMessage", id: "m1", text: `${"a".repeat(20_000)}THE-END` }, 100);
    history.complete("turn-1");
    await emit("thread.idle");

    const chat = spans().find((span) => attr(span, "gen_ai.output.messages") !== undefined)!;
    const output = String(attr(chat, "gen_ai.output.messages"));
    expect(output).toContain("THE-END");
    expect(output).toContain("[… 4007 earlier characters cut]");
    const tool = spans().find((span) => span.name === "execute_tool mcp__docs__search")!;
    expect(String(attr(tool, "gen_ai.tool.call.arguments"))).toMatch(/\[… 2012 more characters cut\]$/);
    expect(String(attr(tool, "gen_ai.tool.call.result"))).toMatch(/\[… 2000 more characters cut\]$/);
  });

  it("sends tool arguments scrubbed string by string, with their JSON whole", async () => {
    const { history, emit, spans } = await setup({ settings: { captureContent: true } });
    history.request("req-1").start("turn-1", "req-1");
    history.item(
      "turn-1",
      {
        type: "toolCall",
        id: "t1",
        tool: "Grep",
        arguments: { pattern: "API_KEY=", path: "src", env: { GH_TOKEN: "ghs-not-a-known-shape" } },
      },
      100,
      { result: { matches: ["src/a.ts: const x = 'API_KEY=' + key"], count: 1 } },
    );
    history.item("turn-1", { type: "fileRead", id: "f1", path: "/tmp/x?token=abc123" }, 100);
    history.complete("turn-1");
    await emit("thread.idle");
    const tool = spans().find((span) => span.name === "execute_tool Grep")!;
    expect(attr(tool, "gen_ai.tool.call.arguments")).toBe(
      '{"pattern":"API_KEY=","path":"src","env":{"GH_TOKEN":"[redacted]"}}',
    );
    expect(attr(tool, "gen_ai.tool.call.result")).toBe(
      `{"matches":["src/a.ts: const x = 'API_KEY=[redacted]"],"count":1}`,
    );
    const read = spans().find((span) => span.name === "execute_tool Read")!;
    expect(attr(read, "gen_ai.tool.call.arguments")).toBe("/tmp/x?token=[redacted]");
  });
});

describe("failures", () => {
  it("stops retrying once Sentry refuses the key, instead of every minute", async () => {
    let status = 503;
    let posts = 0;
    const { bb, history, emit, tick, clock } = await setup({
      respond: () => {
        posts++;
        return status;
      },
    });
    history.turn();
    await emit("thread.idle");
    status = 401;
    clock.now += 2 * 60_000;
    await tick();
    expect(await bb.storage.kv.list("retry:")).toEqual([]);
    const after = posts;
    for (let round = 0; round < 5; round++) {
      clock.now += 61 * 60_000;
      await tick();
    }
    expect(posts).toBe(after);
  });

  it("drops a retry that finds nothing left to send", async () => {
    const { bb, history, emit, tick, sent } = await setup();
    history.turn();
    await emit("thread.idle");
    // As left by an export that failed after its turn was recorded as sent.
    await bb.storage.kv.set(`retry:${THREAD}`, { attempts: 1, nextAt: 0 });
    await tick();
    expect(await bb.storage.kv.list("retry:")).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("skips a turn Sentry refuses as it is, so the turns after it still go", async () => {
    let status = 200;
    const { history, emit, spans } = await setup({ respond: () => status });
    history.turn();
    await emit("thread.idle");
    status = 413;
    history.turn();
    await emit("thread.idle");
    status = 200;
    history.turn();
    await emit("thread.idle");
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => attr(span, "bb.turn.index"))).toEqual([1, 3]);
  });

  it("does not send a long turn's spans twice when a later request of it fails", async () => {
    let requests = 0;
    const { history, emit, tick, clock, spans } = await setup({
      respond: () => (++requests === 2 ? 503 : 200),
    });
    await emit("thread.active");
    history.request("req-1");
    history.start("t1", "req-1");
    for (let index = 0; index < 450; index++) {
      history.item("t1", { type: "commandExecution", id: `c${index}`, command: "ls" }, 10);
    }
    history.complete("t1");
    history.usage(CLAUDE_TOTAL);
    await emit("thread.idle");
    clock.now += 2 * 60_000;
    await tick();

    const ids = spans().map((span) => span.spanId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(spans().filter((span) => span.name === "execute_tool shell")).toHaveLength(450);
    const withUsage = spans().filter((span) => attr(span, "gen_ai.usage.input_tokens") !== undefined);
    expect(withUsage).toHaveLength(1);
    expect(attr(must(withUsage[0], "span with usage"), "gen_ai.usage.input_tokens")).toBe(10_100);
  });

  it("retries an export that could not reach Sentry, then sends the turn once", async () => {
    let status = 503;
    const { bb, history, emit, tick, sent, clock } = await setup({ respond: () => status });
    history.turn();
    await emit("thread.idle");
    expect(sent).toHaveLength(0);
    expect(await bb.storage.kv.get(`retry:${THREAD}`)).toMatchObject({ attempts: 1 });

    // Not due yet.
    status = 200;
    await tick();
    expect(sent).toHaveLength(0);

    clock.now += 2 * 60_000;
    await tick();
    expect(sent).toHaveLength(1);
    expect(await bb.storage.kv.list("retry:")).toEqual([]);
    await tick();
    expect(sent).toHaveLength(1);
  });

  it("does not queue a retry when Sentry rejects the key", async () => {
    const { bb, harness, history, emit } = await setup({ respond: () => 401 });
    history.turn();
    await emit("thread.idle");
    expect(await bb.storage.kv.list("retry:")).toEqual([]);
    expect(harness.inspection.logEntries.some((entry) => entry.message.includes("401"))).toBe(true);
    // The key is never logged.
    expect(JSON.stringify(harness.inspection.logEntries)).not.toContain("0123456789abcdef");
  });

  it("never throws from an event handler when bb's own API fails", async () => {
    const { harness, emit, sent } = await setup();
    harness.sdk.stub("threads.events.list", async () => {
      throw new Error("server busy");
    });
    await expect(emit("thread.idle")).resolves.toBeGreaterThan(0);
    expect(sent).toHaveLength(0);
    expect(
      harness.inspection.logEntries.some((entry) => entry.message.includes("server busy")),
    ).toBe(true);
  });

  it("forgets a deleted thread", async () => {
    const { bb, harness, history, emit } = await setup();
    history.turn();
    await emit("thread.idle");
    expect(await bb.storage.kv.get(`thread:${THREAD}`)).toBeDefined();
    await harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: THREAD }),
    });
    await vi.waitFor(async () =>
      expect(await bb.storage.kv.get(`thread:${THREAD}`)).toBeUndefined(),
    );
  });

  it("sends a failed first turn with the next one, not just the next one", async () => {
    let status = 503;
    const { history, emit, spans } = await setup({ respond: () => status });
    await emit("thread.active");
    history.turn();
    await emit("thread.idle");
    expect(spans()).toHaveLength(0);
    status = 200;
    history.turn();
    await emit("thread.idle");
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => attr(span, "bb.turn.index"))).toEqual([1, 2]);
  });
});

describe("trace providers", () => {
  const PROVIDER_ERROR = "PROVIDER-ERROR-TEXT-yak";
  const traceOf = { key: KEY, pipeline: "feature", attributes: { "example.run_id": KEY } };
  const context = (extra: Record<string, unknown> = {}, trace: Record<string, unknown> = {}) => ({
    trace: { ...traceOf, ...trace },
    ...extra,
  });
  const span = (key: string, extra: Record<string, unknown> = {}) => ({
    key,
    parentKey: "root",
    name: key,
    start: 1_800_000_100_000,
    end: 1_800_000_300_000,
    ...extra,
  });
  const trace = (ended: boolean, spans: unknown[] = []) => ({
    key: KEY,
    ended,
    pipeline: "feature",
    attributes: { "example.run_id": KEY },
    spans: [
      span("root", { parentKey: null, name: "example.run feature", op: "example.run", start: 1_800_000_000_000, end: 1_800_000_400_000 }),
      ...spans,
    ],
  });

  it("exports a thread no provider claimed on its own, at once, and asks no plugin", async () => {
    const { history, emit, spans, rpc } = await setup();
    history.turn();
    await emit("thread.idle");
    expect(rpc).not.toHaveBeenCalled();
    expect(must(spans()[0], "first span").parentSpanId).toBeUndefined();
    expect(attr(must(spans()[0], "first span"), "bb.trace.provider")).toBeUndefined();
  });

  it("offers its two methods for discovery", async () => {
    const { harness } = await setup();
    const published = harness.inspection.registrations.experimental_publishedRpcMethods;
    expect(published.map((method) => method.method).sort()).toEqual(["report_threads", "report_trace"]);
  });

  it("puts every thread of a trace in it, under the span its provider names", async () => {
    const { histories, emit, tick, spans, sent, claim, report } = await setup();
    const answer = await claim({
      [THREAD]: context({ agent: { id: "coordinator", name: "Lead" }, attributes: { "example.role": "coordinator" } }),
      thr_worker: context({ parent: "step-1", agent: { id: "developer", name: "Senior Dev" } }),
      thr_sub: context({ parent: "subtask-ENG-8", agent: { id: "docs" } }),
    });
    expect(answer).toEqual({ contract: 2, sending: true, results: { [THREAD]: "ok", thr_worker: "ok", thr_sub: "ok" } });
    const spansOf = (ended: boolean) =>
      trace(ended, [
        span("step-1", { name: "example.step develop#1", op: "example.step" }),
        span("decision-1", {
          name: "decide example/decider-1",
          op: "gen_ai.decide",
          kind: "client",
          attributes: {
            "gen_ai.operation.name": "decide",
            "gen_ai.request.model": "example/decider-1",
            "gen_ai.usage.input_tokens": 400,
          },
          content: { "gen_ai.input.messages": SECRETS.toolArg },
        }),
        span("verify-1", {
          parentKey: "step-1",
          name: "example.verify",
          status: "error",
          errorType: "verify_failed",
          errorMessage: SECRETS.toolError,
        }),
        // Its parent is not in the trace: it hangs under the root.
        span("subtask-ENG-8", { parentKey: "nowhere", name: "example.subtask ENG-8" }),
      ]);
    expect(await report(spansOf(false))).toEqual({ contract: 2, sending: true });
    for (const id of ["thr_worker", "thr_sub"]) histories[id] = new History();
    for (const id of [THREAD, "thr_worker", "thr_sub"]) {
      must(histories[id], id).turn();
      await emit("thread.idle", id);
    }

    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    // Agents carry the names their provider gives them, else its id.
    expect(names(agents)).toEqual(["invoke_agent Lead", "invoke_agent Senior Dev", "invoke_agent docs"]);
    expect(agents.map((span) => attr(span, "bb.agent.id"))).toEqual(["coordinator", "developer", "docs"]);
    expect(new Set(spans().map((span) => span.traceId))).toEqual(new Set([providerTraceId(P, KEY)]));
    expect(agents.map((span) => span.parentSpanId)).toEqual([
      providerSpanId(P, KEY, "root"),
      providerSpanId(P, KEY, "step-1"),
      providerSpanId(P, KEY, "subtask-ENG-8"),
    ]);
    // Each thread is still its own conversation.
    expect(agents.map((span) => attr(span, "gen_ai.conversation.id"))).toEqual([THREAD, "thr_worker", "thr_sub"]);
    for (const span of spans()) {
      expect(attr(span, "bb.trace.provider")).toBe(P);
      expect(attr(span, "bb.trace.key")).toBe(KEY);
      expect(attr(span, "example.run_id")).toBe(KEY);
      expect(attr(span, "gen_ai.pipeline.name")).toBe("feature");
    }
    // A thread's own attributes stay on that thread.
    expect(attr(must(agents[0], "first agent span"), "example.role")).toBe("coordinator");
    expect(attr(must(agents[1], "second agent span"), "example.role")).toBeUndefined();

    // The trace's own spans wait for it to end, and are then sent once.
    const before = sent.length;
    await tick();
    expect(sent).toHaveLength(before);
    await report(spansOf(true));
    await tick();
    await tick();
    expect(sent).toHaveLength(before + 1);
    const structure = sent.at(-1)!.spans;
    expect(names(structure)).toEqual([
      "example.run feature",
      "example.step develop#1",
      "decide example/decider-1",
      "example.verify",
      "example.subtask ENG-8",
    ]);
    const root = must(structure[0], "root span");
    const step = must(structure[1], "step span");
    const decide = must(structure[2], "decide span");
    const verify = must(structure[3], "verify span");
    const subtask = must(structure[4], "subtask span");
    expect(root.spanId).toBe(providerSpanId(P, KEY, "root"));
    expect(root.parentSpanId).toBeUndefined();
    expect(attr(root, "sentry.op")).toBe("example.run");
    expect(attr(root, "sentry.description")).toBe("example.run feature");
    expect(step.spanId).toBe(providerSpanId(P, KEY, "step-1"));
    expect(step.parentSpanId).toBe(root.spanId);
    expect(decide.kind).toBe(3);
    expect(attr(decide, "gen_ai.operation.name")).toBe("decide");
    expect(attr(decide, "gen_ai.usage.input_tokens")).toBe(400);
    expect(verify.parentSpanId).toBe(step.spanId);
    expect(verify.status).toEqual({ code: 2, message: "verify_failed" });
    expect(attr(verify, "error.type")).toBe("verify_failed");
    expect(subtask.spanId).toBe(providerSpanId(P, KEY, "subtask-ENG-8"));
    expect(subtask.parentSpanId).toBe(root.spanId);
    for (const span of structure) expect(attr(span, "example.run_id")).toBe(KEY);
  });

  it("sends a provider's content and error text only with content capture, scrubbed", async () => {
    const { history, emit, tick, sent, claim, report } = await setup({ settings: { captureContent: true } });
    await claim({ [THREAD]: context() });
    await report(
      trace(true, [
        span("decision-1", {
          content: { "gen_ai.input.messages": `${SECRETS.toolArg} ghp_abcdefghijklmnopqrstuvwxyz0123` },
          status: "error",
          errorType: "decide_failed",
          errorMessage: SECRETS.toolError,
        }),
      ]),
    );
    history.turn();
    await emit("thread.idle");
    await tick();
    const decision = sent.at(-1)!.spans.find((span) => span.name === "decision-1")!;
    expect(attr(decision, "gen_ai.input.messages")).toBe(`${SECRETS.toolArg} [redacted]`);
    expect(decision.status).toEqual({ code: 2, message: SECRETS.toolError });
  });

  it("neither keeps nor sends a provider's content while content capture is off", async () => {
    const { bb, harness, history, emit, tick, sent, claim, report } = await setup();
    await claim({ [THREAD]: context() });
    await report(
      trace(true, [
        span("decision-1", {
          content: { "gen_ai.input.messages": SECRETS.rationale },
          status: "error",
          errorType: "decide_failed",
          errorMessage: PROVIDER_ERROR,
        }),
      ]),
    );
    const stored = await Promise.all((await bb.storage.kv.list()).map((key) => bb.storage.kv.get(key)));
    expect(JSON.stringify(stored)).not.toContain(SECRETS.rationale);
    expect(JSON.stringify(stored)).not.toContain(PROVIDER_ERROR);
    // Turned on after the report: what was not kept is not sent either.
    await harness.behavior.setSettings({ captureContent: true });
    history.turn();
    await emit("thread.idle");
    await tick();
    const decision = sent.at(-1)!.spans.find((span) => span.name === "decision-1")!;
    expect(decision.status).toEqual({ code: 2, message: "decide_failed" });
    expect(JSON.stringify(sent)).not.toContain(SECRETS.rationale);
    expect(JSON.stringify(sent)).not.toContain(PROVIDER_ERROR);
  });

  it("drops content kept while capture was on when it is turned off before sending", async () => {
    const { harness, history, emit, tick, sent, claim, report } = await setup({ settings: { captureContent: true } });
    await claim({ [THREAD]: context() });
    await report(trace(true, [span("decision-1", { content: { "gen_ai.input.messages": SECRETS.rationale } })]));
    history.turn();
    await harness.behavior.setSettings({ captureContent: false });
    await emit("thread.idle");
    await tick();
    expect(sent.at(-1)!.spans.some((span) => span.name === "decision-1")).toBe(true);
    expect(JSON.stringify(sent)).not.toContain(SECRETS.rationale);
  });

  it("gives a turn that starts after the trace ended its own trace", async () => {
    const { bb, history, emit, spans, claim } = await setup();
    await claim({ [THREAD]: context() });
    history.turn();
    await emit("thread.idle");
    // The trace ends during this turn: the turn still belongs to it.
    history.turn();
    await claim({ [THREAD]: context({}, { endedAt: history.now }) });
    await emit("thread.idle");
    // Days later, the user keeps chatting in the same thread.
    history.wait(60_000).turn();
    await emit("thread.idle");

    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(agents.map((span) => span.traceId === providerTraceId(P, KEY))).toEqual([true, true, false]);
    const third = must(agents[2], "third agent span");
    expect(third.parentSpanId).toBeUndefined();
    expect(attr(third, "bb.trace.provider")).toBeUndefined();
    expect(attr(third, "example.run_id")).toBeUndefined();
    // Still the same conversation.
    expect(attr(third, "gen_ai.conversation.id")).toBe(THREAD);
    expect(await bb.storage.kv.list("trace:")).toEqual([`trace:${P}/${KEY}`]);
  });

  it("sends the spans a snapshot marks final before the trace ends, each once, at the next tick", async () => {
    const { bb, history, emit, tick, sent, claim, report } = await setup();
    await claim({ [THREAD]: context() });
    let spansNow: unknown[] = [span("decision-1", { final: true, op: "gen_ai.decide", kind: "client" })];
    await report(trace(false, spansNow));
    history.turn();
    await emit("thread.idle");
    const before = sent.length;

    // A final span goes out while the trace is open, under the root still to come.
    await tick();
    expect(sent).toHaveLength(before + 1);
    const early = must(sent.at(-1), "early request").spans;
    expect(names(early)).toEqual(["decision-1"]);
    expect(must(early[0], "decision span").parentSpanId).toBe(providerSpanId(P, KEY, "root"));
    expect(must(early[0], "decision span").traceId).toBe(providerTraceId(P, KEY));
    // Nothing new: nothing is sent, and the same snapshot is not read again.
    await tick();
    expect(sent).toHaveLength(before + 1);

    // A span that may still change waits for the end.
    spansNow = [...spansNow, span("step-1", { final: false }), span("verify-1", { parentKey: "step-1", final: true })];
    await report(trace(false, spansNow));
    const entry = (await bb.storage.kv.get(`trace:${P}/${KEY}`)) as { sentKeys: string[] };
    expect(entry.sentKeys).toEqual(["decision-1"]);
    await tick();
    expect(sent).toHaveLength(before + 2);
    const second = must(sent.at(-1), "second request").spans;
    expect(names(second)).toEqual(["verify-1"]);
    // Linked to its parent, though that parent is not sent yet.
    expect(must(second[0], "verify span").parentSpanId).toBe(providerSpanId(P, KEY, "step-1"));

    // At the end, the rest: the root and what was not final.
    await report(trace(true, spansNow));
    await tick();
    expect(sent).toHaveLength(before + 3);
    expect(names(must(sent.at(-1), "last request").spans)).toEqual(["example.run feature", "step-1"]);
    expect(await bb.storage.kv.get(`trace:${P}/${KEY}`)).toMatchObject({ sentAt: expect.any(Number) as unknown });
    // Reported again after it was sent: nothing goes twice.
    await report(trace(true, spansNow));
    await tick();
    expect(sent).toHaveLength(before + 3);
  });

  it("waits for a trace's first snapshot, however long, until the trace is old", async () => {
    const { bb, history, emit, tick, sent, claim, report, clock } = await setup();
    await claim({ [THREAD]: context() });
    history.turn();
    await emit("thread.idle");
    const before = sent.length;
    clock.now += 20 * 24 * 60 * 60_000;
    await tick();
    expect(sent).toHaveLength(before);
    expect(await bb.storage.kv.get(`trace:${P}/${KEY}`)).toMatchObject({ sentAt: null });
    await report(trace(true));
    await tick();
    expect(names(must(sent.at(-1), "request").spans)).toEqual(["example.run feature"]);
  });

  it("never sends a root early, even one marked final", async () => {
    const { history, emit, tick, sent, claim, report } = await setup();
    await claim({ [THREAD]: context() });
    await report({
      key: KEY,
      ended: false,
      spans: [span("root", { parentKey: null, name: "example.run feature", final: true }), span("pick-1", { final: true })],
    });
    history.turn();
    await emit("thread.idle");
    const before = sent.length;
    await tick();
    expect(names(must(sent.at(-1), "request").spans)).toEqual(["pick-1"]);
    expect(sent).toHaveLength(before + 1);
  });

  it("sends a trace still open after 30 days as it stands, its root marked open", async () => {
    const { bb, history, emit, tick, sent, clock, claim, report } = await setup();
    await claim({ [THREAD]: context() });
    await report(trace(false, [span("step-1")]));
    history.turn();
    await emit("thread.idle");
    const before = sent.length;
    await tick();
    expect(sent).toHaveLength(before);
    clock.now += 31 * 24 * 60 * 60_000;
    await tick();
    expect(sent).toHaveLength(before + 1);
    const structure = must(sent.at(-1), "request").spans;
    expect(names(structure)).toEqual(["example.run feature", "step-1"]);
    expect(attr(must(structure[0], "root span"), "bb.trace.state")).toBe("open");
    expect(attr(must(structure[1], "step span"), "bb.trace.state")).toBeUndefined();
    expect(await bb.storage.kv.get(`trace:${P}/${KEY}`)).toMatchObject({ sentAt: expect.any(Number) as unknown });
  });

  it("gives a trace its provider deleted a root, once", async () => {
    const { bb, history, emit, tick, sent, claim, report, reportDeleted } = await setup();
    await claim({ [THREAD]: context() });
    await report(trace(false));
    history.turn();
    await emit("thread.idle");
    const before = sent.length;
    // A trace that has not ended keeps its root waiting.
    await tick();
    expect(sent).toHaveLength(before);
    await reportDeleted(KEY);
    await tick();
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)!.spans).toHaveLength(1);
    const root = must(sent.at(-1)?.spans[0], "root span");
    expect(root.spanId).toBe(providerSpanId(P, KEY, "root"));
    expect(root.traceId).toBe(providerTraceId(P, KEY));
    expect(attr(root, "bb.trace.state")).toBe("deleted");
    expect(attr(root, "example.run_id")).toBe(KEY);
    expect(await bb.storage.kv.get(`trace:${P}/${KEY}`)).toMatchObject({ sentAt: expect.any(Number) as unknown });
    await tick();
    expect(sent).toHaveLength(before + 1);
  });

  it("drops a trace's snapshot with its entry, a day after it was sent", async () => {
    const { bb, history, emit, tick, clock, claim, report } = await setup();
    await claim({ [THREAD]: context() });
    await report(trace(true, [span("step-1")]));
    history.turn();
    await emit("thread.idle");
    await tick();
    expect(await bb.storage.kv.list("snapshot")).not.toEqual([]);
    clock.now += 25 * 60 * 60_000;
    await tick();
    expect(await bb.storage.kv.list("trace:")).toEqual([]);
    expect(await bb.storage.kv.list("snapshot")).toEqual([]);
  });

  describe("only takes reports from another plugin, on its contract", () => {
    it("refuses the app, the CLI and agents", async () => {
      const { bb, harness } = await setup();
      const input = { contract: 2, threads: [{ threadId: THREAD, context: context() }] };
      await expect(harness.behavior.callRpc("report_threads", input)).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        harness.behavior.callRpc("report_trace", { contract: 2, trace: trace(true) }, { experimental_caller: { kind: "client" } }),
      ).rejects.toMatchObject({ code: "forbidden" });
      expect(await bb.storage.kv.list()).toEqual([]);
    });

    it("refuses itself", async () => {
      const { bb, harness } = await setup();
      const input = { contract: 2, threads: [{ threadId: THREAD, context: context() }] };
      await expect(harness.behavior.callRpc("report_threads", input, asPlugin("sentry-traces"))).rejects.toMatchObject({
        code: "forbidden",
      });
      expect(await bb.storage.kv.list("claim:")).toEqual([]);
    });

    it("refuses another contract version, naming the one it speaks", async () => {
      const { bb, harness } = await setup();
      const input = { contract: 1, threads: [{ threadId: THREAD, context: context() }] };
      const refused = harness.behavior.callRpc("report_threads", input, asPlugin(P));
      await expect(refused).rejects.toMatchObject({ code: "invalid" });
      await expect(refused).rejects.toThrow(/contract 2/);
      await expect(
        harness.behavior.callRpc("report_trace", { contract: 3, trace: trace(true) }, asPlugin(P)),
      ).rejects.toThrow(/contract 2/);
      expect(await bb.storage.kv.list("claim:")).toEqual([]);
    });

    it("refuses a malformed report", async () => {
      const { harness, history, emit, spans } = await setup();
      const bad = { contract: 2, threads: [{ threadId: THREAD, context: { trace: { key: "" } } }] };
      await expect(harness.behavior.callRpc("report_threads", bad, asPlugin(P))).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(
        harness.behavior.callRpc("report_trace", { contract: 2 }, asPlugin(P)),
      ).rejects.toMatchObject({ code: "invalid" });
      history.turn();
      await emit("thread.idle");
      expect(must(spans()[0], "first span").parentSpanId).toBeUndefined();
    });
  });

  describe("thread claims", () => {
    it("keeps a thread with the provider that claimed it first, until that one lets go", async () => {
      const { history, emit, spans, claim } = await setup();
      expect((await claim({ [THREAD]: context() })).results).toEqual({ [THREAD]: "ok" });
      expect((await claim({ [THREAD]: { trace: { key: "theirs" } } }, "other-provider")).results).toEqual({
        [THREAD]: "conflict",
      });
      // Nor can the other one clear it.
      expect((await claim({ [THREAD]: null }, "other-provider")).results).toEqual({ [THREAD]: "conflict" });
      history.turn();
      await emit("thread.idle");
      expect(new Set(spans().map((span) => span.traceId))).toEqual(new Set([providerTraceId(P, KEY)]));

      expect((await claim({ [THREAD]: null })).results).toEqual({ [THREAD]: "ok" });
      expect((await claim({ [THREAD]: { trace: { key: "theirs" } } }, "other-provider")).results).toEqual({
        [THREAD]: "ok",
      });
      const before = spans().length;
      history.turn();
      await emit("thread.idle");
      const later = spans().slice(before);
      expect(new Set(later.map((span) => span.traceId))).toEqual(new Set([providerTraceId("other-provider", "theirs")]));
      expect(attr(must(later[0], "agent span"), "bb.trace.provider")).toBe("other-provider");
    });

    it("exports a thread whose claim was cleared on its own", async () => {
      const { history, emit, spans, claim } = await setup();
      await claim({ [THREAD]: context() });
      history.turn();
      await emit("thread.idle");
      await claim({ [THREAD]: null });
      const before = spans().length;
      history.turn();
      await emit("thread.idle");
      const later = spans().slice(before);
      expect(later.length).toBeGreaterThan(0);
      expect(later.some((span) => attr(span, "bb.trace.provider") !== undefined)).toBe(false);
    });

    it("refuses a claim too large to keep, and keeps the others of the call", async () => {
      const { claim } = await setup();
      const attributes = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`example.a${n}`, "x".repeat(2_000)]));
      const answer = await claim({
        thr_big: { trace: { key: KEY, attributes }, attributes },
        [THREAD]: context(),
      });
      expect(answer.results).toEqual({ thr_big: "invalid", [THREAD]: "ok" });
    });

    it("drops a deleted thread's claim", async () => {
      const { bb, harness, claim } = await setup();
      await claim({ [THREAD]: context() });
      expect(await bb.storage.kv.list("claim:")).toEqual([`claim:${THREAD}`]);
      await harness.behavior.emitThreadEvent("thread.deleted", {
        thread: makeThreadResponse({ id: THREAD, providerId: "claude-code", projectId: "proj_1" }),
      });
      await vi.waitFor(async () => expect(await bb.storage.kv.list("claim:")).toEqual([]));
    });

    it("keeps a claim made while export is off, and sends from the turns after it is turned on", async () => {
      const { harness, history, emit, spans, claim, clock } = await setup({ settings: { enabled: false } });
      const answer = await claim({ [THREAD]: context({ agent: { name: "Lead" } }) });
      expect(answer).toMatchObject({ sending: false, results: { [THREAD]: "ok" } });
      history.turn();
      await emit("thread.idle");
      expect(spans()).toHaveLength(0);
      await harness.behavior.setSettings({ enabled: true });
      history.wait(clock.now - history.now + 1_000).turn();
      await emit("thread.idle");
      // Only the turn that finished after export was turned on, in the trace it was claimed for.
      expect(turnIndexes(spans())).toEqual([2]);
      expect(must(spans()[0], "agent span").name).toBe("invoke_agent Lead");
      expect(new Set(spans().map((span) => span.traceId))).toEqual(new Set([providerTraceId(P, KEY)]));
    });
  });

  describe("trace snapshots", () => {
    it("keeps no snapshot while export is off, and says so", async () => {
      const { bb, report } = await setup({ settings: { enabled: false } });
      expect(await report(trace(true, [span("step-1")]))).toEqual({ contract: 2, sending: false });
      expect(await bb.storage.kv.list("snapshot")).toEqual([]);
    });

    it("stores a large snapshot in parts and sends every span of it", async () => {
      const { bb, history, emit, tick, sent, claim, report } = await setup();
      await claim({ [THREAD]: context() });
      const many = Array.from({ length: 1_500 }, (_, n) =>
        span(`step-${n}`, { name: "example.step", attributes: { "example.note": "n".repeat(1_000), "example.n": n } }),
      );
      await report(trace(false, many));
      const parts = await bb.storage.kv.list("snapshot-part:");
      expect(parts.length).toBeGreaterThan(4);
      // A newer report replaces the parts of the one before.
      await report(trace(true, many));
      expect(await bb.storage.kv.list("snapshot-part:")).toHaveLength(parts.length);
      expect(await bb.storage.kv.list("snapshot-part:")).not.toEqual(parts);
      history.turn();
      await emit("thread.idle");
      await tick();
      const steps = sent.flatMap((request) => request.spans).filter((span) => span.name === "example.step");
      expect(steps).toHaveLength(many.length);
      expect(new Set(steps.map((span) => attr(span, "example.n"))).size).toBe(many.length);
    });

    it("refuses a snapshot larger than 4 MB, or with a span larger than one stored value", async () => {
      const { bb, report } = await setup();
      const big = Array.from({ length: 1_000 }, (_, n) => span(`s${n}`, { attributes: { "example.note": "b".repeat(5_000) } }));
      await expect(report(trace(true, big))).rejects.toMatchObject({ code: "invalid" });
      await expect(report(trace(true, big))).rejects.toThrow(/4 MB/);
      const wide = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`example.c${n}`, "w".repeat(8_000)]));
      await expect(
        report({ ...trace(true, [span("wide", { content: wide })]) }),
      ).resolves.toMatchObject({ sending: true });
      expect(await bb.storage.kv.list("snapshot")).not.toEqual([]);
    });

    it("refuses a span larger than one stored value with content capture on", async () => {
      const { report } = await setup({ settings: { captureContent: true } });
      const wide = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`example.c${n}`, "w".repeat(8_000)]));
      await expect(report(trace(true, [span("wide", { content: wide })]))).rejects.toThrow(/span wide is larger/);
    });

    it("refuses a trace with more spans than the limit", async () => {
      const { harness, history, emit, tick, sent, claim } = await setup();
      await claim({ [THREAD]: context() });
      const input = { contract: 2, trace: trace(true, Array.from({ length: 2_001 }, (_, index) => span(`s${index}`))) };
      await expect(harness.behavior.callRpc("report_trace", input, asPlugin(P))).rejects.toMatchObject({
        code: "invalid_input",
      });
      history.turn();
      await emit("thread.idle");
      const before = sent.length;
      await tick();
      expect(sent).toHaveLength(before);
    });
  });

  describe("does not trust what a provider sends", () => {
    it("drops attributes that are reserved, not scalar or badly named, and keeps its own", async () => {
      const { history, emit, spans, claim } = await setup();
      await claim({
        [THREAD]: context({
          attributes: {
            "sentry.op": "evil",
            "gen_ai.conversation.id": "someone-else",
            "bb.thread.id": "thr_other",
            "bb.provider.id": "evil-provider",
            "bad key": "x",
            nested: { a: 1 },
            list: [1, 2],
            long: "y".repeat(5_000),
            ok: 7,
          },
        }),
      });
      history.turn();
      await emit("thread.idle");
      const agent = must(spans()[0], "agent span");
      expect(attr(agent, "sentry.op")).toBe("gen_ai.invoke_agent");
      expect(attr(agent, "gen_ai.conversation.id")).toBe(THREAD);
      expect(attr(agent, "bb.thread.id")).toBe(THREAD);
      // Not reserved, but this plugin's own value wins.
      expect(attr(agent, "bb.provider.id")).toBe("claude-code");
      expect(attr(agent, "bad key")).toBeUndefined();
      expect(attr(agent, "nested")).toBeUndefined();
      expect(attr(agent, "list")).toBeUndefined();
      expect(String(attr(agent, "long"))).toHaveLength(2_000);
      expect(attr(agent, "ok")).toBe(7);
    });

    it("gives a trace without a root one, and keeps the first of two spans with one key", async () => {
      const { history, emit, tick, sent, claim, report } = await setup();
      await claim({ [THREAD]: context() });
      await report({
        key: KEY,
        ended: true,
        spans: [span("a", { name: "first" }), span("a", { name: "second" }), span("b", { parentKey: "a" })],
      });
      history.turn();
      await emit("thread.idle");
      await tick();
      const structure = sent.at(-1)!.spans;
      expect(names(structure)).toEqual([`${P}.trace feature`, "first", "b"]);
      const root = must(structure[0], "root span");
      const second = must(structure[1], "second span");
      const third = must(structure[2], "third span");
      expect(root.spanId).toBe(providerSpanId(P, KEY, "root"));
      expect(second.parentSpanId).toBe(root.spanId);
      expect(third.parentSpanId).toBe(second.spanId);
    });
  });
});

describe("a provider's recorded reports", () => {
  // What a provider reported for an open task-loop run with a model decision,
  // one dispatched attempt, two model picks and a verify, its names made neutral.
  const real = JSON.parse(readFileSync(new URL("./fixtures/provider-reports.json", import.meta.url), "utf8")) as {
    coordinatorThreadId: string;
    workerThreadId: string;
    scriptName: string;
    report_threads: { contract: number; threads: Array<{ threadId: string; context: unknown }> };
    report_trace: {
      contract: number;
      trace: { key: string; spans: Array<{ key: string; name: string; op: string; final?: boolean }> };
    };
  };
  const KEY = real.report_trace.trace.key;
  const send = async (harness: Awaited<ReturnType<typeof setup>>["harness"], trace = real.report_trace) => {
    await harness.behavior.callRpc("report_threads", real.report_threads, asPlugin(P));
    await harness.behavior.callRpc("report_trace", trace, asPlugin(P));
  };

  it("send the run's decision, picks and verify while the run is still open", async () => {
    const coordinator = real.coordinatorThreadId;
    const { harness, histories, emit, tick, sent } = await setup();
    await send(harness);
    histories[coordinator] = new History();
    must(histories[coordinator], coordinator).turn();
    await emit("thread.idle", coordinator);
    const before = sent.length;
    await tick();
    expect(sent).toHaveLength(before + 1);
    const early = must(sent.at(-1), "early request").spans;
    expect(early.map((span) => attr(span, "sentry.op")).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "example.pick",
      "example.pick",
      "example.verify",
      "gen_ai.decide",
    ]);
    const decide = must(
      early.find((span) => attr(span, "sentry.op") === "gen_ai.decide"),
      "decide span",
    );
    expect(decide.kind).toBe(3);
    expect(attr(decide, "gen_ai.request.model")).toBe("decider-test");
    expect(attr(decide, "gen_ai.usage.input_tokens")).toBe(120);
  });

  it("are accepted as they are, and place a run's threads and workflow", async () => {
    const coordinator = real.coordinatorThreadId;
    const worker = real.workerThreadId;
    const { harness, histories, emit, tick, spans, sent, clock } = await setup({
      threads: { [worker]: { originPluginId: "workflows", lifecycleOwnerThreadId: coordinator } },
      workflows: {
        metadata: { [worker]: { workflowWorker: 1, runId: "wf_real", callId: "call_0", originThreadId: coordinator } },
        view: () => ({
          id: "wf_real",
          name: real.scriptName,
          status: "succeeded",
          phases: [],
          unphasedCalls: [
            {
              id: "call_0",
              index: 0,
              label: "developer: attempt",
              phase: "Implement",
              status: "succeeded",
              provider: "prov-a",
              model: "model-a2",
              reasoningLevel: "medium",
              childThreadId: worker,
              createdAt: 1_800_000_010_000,
              startedAt: 1_800_000_011_000,
              finishedAt: 1_800_000_020_000,
            },
          ],
          createdAt: 1_800_000_009_000,
          startedAt: 1_800_000_010_000,
          finishedAt: 1_800_000_030_000,
        }),
      },
    });
    // The recorded run was still open; say it ended so its spans are sent.
    await send(harness, { ...real.report_trace, trace: { ...real.report_trace.trace, ended: true } as never });
    for (const id of [coordinator, worker]) {
      histories[id] = new History();
      must(histories[id], id).turn();
      await emit("thread.idle", id);
    }
    const agentSpans = spans().filter((span) => span.name.startsWith("invoke_agent"));
    const lead = must(agentSpans[0], "lead agent span");
    const developer = must(agentSpans[1], "developer agent span");
    // The coordinator is named as the user named the agent.
    expect(lead.name).toBe("invoke_agent Coordinator");
    expect(attr(lead, "bb.agent.id")).toBe("coordinator");
    expect(lead.parentSpanId).toBe(providerSpanId(P, KEY, "root"));
    expect(attr(lead, "example.role")).toBe("coordinator");
    // The provider did not claim the worker; it joins through the coordinator.
    expect(developer.traceId).toBe(providerTraceId(P, KEY));
    expect(developer.parentSpanId).toBe(workflowCallSpanId("wf_real", "call_0"));
    expect(attr(developer, "example.run_id")).toBe(KEY);
    expect(attr(developer, "gen_ai.pipeline.name")).toBe("task-loop");

    clock.now = 1_800_000_030_000 + 1_000;
    await tick();
    const sentNames = sent.flatMap((request) => names(request.spans));
    for (const span of real.report_trace.trace.spans) expect(sentNames).toContain(span.name);
    // The workflow run hangs under the step whose compiled script it ran.
    const step = real.report_trace.trace.spans.find((span) => span.name.startsWith("example.step"))!;
    const workflow = sent.flatMap((request) => request.spans).find((span) => span.name.startsWith("invoke_workflow"))!;
    expect(workflow.parentSpanId).toBe(providerSpanId(P, KEY, step.key));
  });
});

describe("bb details", () => {
  const environment = {
    environmentId: "env_1",
    environmentHostId: "host_1",
    environmentIsWorktree: true,
    environmentBranchName: SECRETS.branch,
    parentThreadId: "thr_parent",
    originKind: "plugin",
    originPluginId: "automations",
    visibility: "hidden",
  };

  it("says where a turn ran, who started it and how the thread came to be", async () => {
    const { history, emit, spans, sent } = await setup({ threads: { [THREAD]: environment } });
    history.turn();
    await emit("thread.idle");
    const agent = must(spans()[0], "agent span");
    expect(attr(agent, "bb.environment.id")).toBe("env_1");
    expect(attr(agent, "bb.environment.worktree")).toBe(true);
    expect(attr(agent, "bb.host.id")).toBe("host_1");
    expect(attr(agent, "bb.thread.parent_id")).toBe("thr_parent");
    expect(attr(agent, "bb.thread.origin")).toBe("plugin");
    expect(attr(agent, "bb.thread.origin_plugin")).toBe("automations");
    expect(attr(agent, "bb.thread.hidden")).toBe(true);
    expect(attr(agent, "bb.turn.initiator")).toBe("user");
    expect(attr(agent, "bb.turn.source")).toBe("spawn");
    expect(attr(agent, "bb.permission_mode")).toBe("auto");
    // bb names a branch after the thread's title, so it counts as content.
    expect(JSON.stringify(sent)).not.toContain(SECRETS.branch);
  });

  it("sends the branch only with content capture", async () => {
    const { history, emit, spans } = await setup({
      settings: { captureContent: true },
      threads: { [THREAD]: environment },
    });
    history.turn();
    await emit("thread.idle");
    expect(attr(must(spans()[0], "first span"), "bb.environment.branch")).toBe(SECRETS.branch);
  });

  it("reports the model a provider fell back to, from the moment it did", async () => {
    const { history, emit, spans } = await setup();
    history.request("req-1").start("turn-1", "req-1");
    history.item("turn-1", { type: "reasoning", id: "r1" }, 1_000);
    history.item("turn-1", { type: "commandExecution", id: "c1", command: "ls" }, 500);
    history.push(
      "provider/modelFallback",
      { originalModel: "claude-fable-5-2", fallbackModel: "claude-opus-5-5", reason: "provider", message: "x" },
      "turn-1",
    );
    history.item("turn-1", { type: "agentMessage", id: "m1", text: "done" }, 1_000);
    history.complete("turn-1");
    await emit("thread.idle");
    const agent = must(spans()[0], "agent span");
    const chats = spans().filter((span) => span.name.startsWith("chat"));
    expect(attr(agent, "gen_ai.request.model")).toBe("claude-fable-5-2");
    expect(attr(agent, "gen_ai.response.model")).toBe("claude-opus-5-5");
    expect(attr(agent, "bb.model_fallback.reason")).toBe("provider");
    expect(chats.map((span) => attr(span, "gen_ai.response.model"))).toEqual([
      "claude-fable-5-2",
      "claude-opus-5-5",
    ]);
  });

  it("reports the rate limit status and context window of a turn", async () => {
    const { history, emit, spans } = await setup();
    history.request("req-1").start("turn-1", "req-1");
    history.push("provider/rateLimits/updated", { rateLimits: { status: "warning" } });
    history.push("thread/contextWindowUsage/updated", {
      contextWindowUsage: { usedTokens: null, modelContextWindow: null },
    });
    history.push("thread/contextWindowUsage/updated", {
      contextWindowUsage: { snapshot: { usedTokens: 287_498, contextWindowTokens: 1_000_000 } },
    });
    history.complete("turn-1");
    await emit("thread.idle");
    const agent = must(spans()[0], "agent span");
    expect(attr(agent, "bb.rate_limit.status")).toBe("warning");
    expect(attr(agent, "bb.context.used_tokens")).toBe(287_498);
    expect(attr(agent, "bb.context.window_tokens")).toBe(1_000_000);
  });
});

describe("workflow runs", () => {
  const WF = "wf_7";
  const WORKERS = ["thr_w1", "thr_w2"];
  const call = (index: number, extra: Record<string, unknown> = {}) => ({
    id: `call_${index}`,
    index,
    label: `${SECRETS.workflowLabel} ${index}`,
    phase: SECRETS.phaseTitle,
    status: "succeeded",
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    reasoningLevel: "medium",
    cached: false,
    childThreadId: WORKERS[index] ?? null,
    providerRetryAttempts: 0,
    repairAttempts: 0,
    error: null,
    createdAt: 1_800_000_010_000 + index * 1_000,
    startedAt: 1_800_000_011_000 + index * 1_000,
    finishedAt: 1_800_000_020_000 + index * 1_000,
    ...extra,
  });
  const view = (status: string, extra: Record<string, unknown> = {}) => ({
    id: WF,
    name: "review-changes",
    description: SECRETS.prompt,
    status,
    currentPhase: null,
    phases: [{ title: SECRETS.phaseTitle, detail: null, calls: [call(0), call(1)] }],
    unphasedCalls: [call(2, { status: "failed", error: SECRETS.toolError, childThreadId: null })],
    resultAvailable: true,
    error: null,
    createdAt: 1_800_000_009_000,
    startedAt: 1_800_000_010_000,
    finishedAt: status === "running" ? null : 1_800_000_030_000,
    ...extra,
  });
  const worker = { originPluginId: "workflows", lifecycleOwnerThreadId: THREAD, visibility: "hidden" };
  const metadata = Object.fromEntries(
    WORKERS.map((id, index) => [
      id,
      { workflowWorker: 1, runId: WF, callId: `call_${index}`, originThreadId: THREAD },
    ]),
  );
  const threads = Object.fromEntries(WORKERS.map((id) => [id, worker]));

  it("puts a workflow's workers in one trace, under their calls", async () => {
    let status = "running";
    const { histories, emit, tick, spans, sent } = await setup({
      threads,
      workflows: { metadata, view: () => view(status) },
    });
    for (const id of WORKERS) {
      histories[id] = new History();
      must(histories[id], id).turn();
      await emit("thread.idle", id);
    }
    const agents = spans().filter((span) => span.name.startsWith("invoke_agent"));
    expect(new Set(spans().map((span) => span.traceId))).toEqual(new Set([workflowTraceId(WF)]));
    expect(agents.map((span) => span.parentSpanId)).toEqual([
      workflowCallSpanId(WF, "call_0"),
      workflowCallSpanId(WF, "call_1"),
    ]);
    for (const span of spans()) {
      expect(attr(span, "bb.workflow.run_id")).toBe(WF);
      expect(attr(span, "bb.workflow.name")).toBe("review-changes");
      expect(attr(span, "gen_ai.pipeline.name")).toBe("review-changes");
      expect(attr(span, "bb.workflow.origin_thread_id")).toBe(THREAD);
    }
    expect(attr(must(agents[1], "second agent span"), "bb.workflow.call.index")).toBe(1);
    // Each worker is still its own conversation.
    expect(agents.map((span) => attr(span, "gen_ai.conversation.id"))).toEqual(WORKERS);

    // The run's own spans wait for the run to end, and are then sent once.
    const before = sent.length;
    await tick();
    expect(sent).toHaveLength(before);
    status = "failed";
    await tick();
    await tick();
    expect(sent).toHaveLength(before + 1);
    const structure = sent.at(-1)!.spans;
    expect(names(structure)).toEqual([
      "invoke_workflow review-changes",
      "workflow.phase 1",
      "workflow.call 0",
      "workflow.call 1",
      "workflow.call 2",
    ]);
    const root = must(structure[0], "root span");
    const phase = must(structure[1], "phase span");
    const first = must(structure[2], "first call span");
    const unphased = must(structure[4], "unphased call span");
    expect(root.spanId).toBe(workflowRootSpanId(WF));
    expect(root.parentSpanId).toBeUndefined();
    expect(root.traceId).toBe(workflowTraceId(WF));
    expect(attr(root, "gen_ai.operation.name")).toBe("invoke_workflow");
    expect(attr(root, "sentry.description")).toBe("invoke_workflow review-changes");
    expect(root.status).toEqual({ code: 2, message: "workflow failed" });
    expect(phase.parentSpanId).toBe(root.spanId);
    expect(first.spanId).toBe(workflowCallSpanId(WF, "call_0"));
    expect(first.parentSpanId).toBe(phase.spanId);
    expect(attr(first, "gen_ai.request.model")).toBe("claude-sonnet-5-5");
    expect(attr(first, "bb.workflow.call.thread_id")).toBe("thr_w1");
    expect(unphased.parentSpanId).toBe(root.spanId);
    expect(unphased.status).toEqual({ code: 2, message: "workflow call failed" });
    // Labels, phase titles and errors are written by the script's author.
    const body = JSON.stringify(sent);
    for (const secret of [SECRETS.workflowLabel, SECRETS.phaseTitle, SECRETS.toolError, SECRETS.prompt]) {
      expect(body).not.toContain(secret);
    }
  });

  it("names phases and calls by their labels with content capture", async () => {
    const { histories, emit, tick, sent } = await setup({
      settings: { captureContent: true },
      threads,
      workflows: { metadata, view: () => view("succeeded") },
    });
    histories['thr_w1'] = new History();
    must(histories['thr_w1'], "thr_w1").turn();
    await emit("thread.idle", "thr_w1");
    await tick();
    expect(names(sent.at(-1)!.spans)).toEqual([
      "invoke_workflow review-changes",
      `workflow.phase ${SECRETS.phaseTitle}`,
      `workflow.call ${SECRETS.workflowLabel} 0`,
      `workflow.call ${SECRETS.workflowLabel} 1`,
      `workflow.call ${SECRETS.workflowLabel} 2`,
    ]);
  });

  it("does not send a workflow name that is free text", async () => {
    const { histories, emit, spans } = await setup({
      threads,
      workflows: { metadata, view: () => view("running", { name: SECRETS.workflowLabel }) },
    });
    histories['thr_w1'] = new History();
    must(histories['thr_w1'], "thr_w1").turn();
    await emit("thread.idle", "thr_w1");
    expect(attr(must(spans()[0], "first span"), "bb.workflow.name")).toBeUndefined();
    expect(JSON.stringify(spans())).not.toContain(SECRETS.workflowLabel);
  });

  it("exports a worker on its own when Workflows cannot place it", async () => {
    const { histories, emit, spans } = await setup({
      threads,
      // Forged or damaged metadata: no call id.
      workflows: { metadata: { thr_w1: { runId: WF } }, view: () => view("running") },
    });
    histories['thr_w1'] = new History();
    must(histories['thr_w1'], "thr_w1").turn();
    await emit("thread.idle", "thr_w1");
    expect(must(spans()[0], "first span").parentSpanId).toBeUndefined();
    expect(attr(must(spans()[0], "first span"), "bb.workflow.run_id")).toBeUndefined();
    expect(attr(must(spans()[0], "first span"), "bb.thread.origin_plugin")).toBe("workflows");
  });

  it("gives a workflow Workflows deleted a root, then stops asking", async () => {
    let gone = false;
    const { histories, emit, tick, sent, rpc } = await setup({
      threads,
      workflows: { metadata, view: () => (gone ? null : view("running")) },
    });
    histories['thr_w1'] = new History();
    must(histories['thr_w1'], "thr_w1").turn();
    await emit("thread.idle", "thr_w1");
    gone = true;
    await tick();
    const root = must(sent.at(-1)?.spans[0], "root span");
    expect(root.spanId).toBe(workflowRootSpanId(WF));
    expect(attr(root, "bb.workflow.status")).toBe("deleted");
    const asked = rpc.mock.calls.length;
    await tick();
    expect(rpc.mock.calls.length).toBe(asked);
  });

  describe("inside a provider's trace", () => {
    const origin = (extra: Record<string, unknown> = {}) => ({
      trace: { key: KEY, pipeline: "feature", attributes: { "example.run_id": KEY } },
      agent: { id: "coordinator", name: "Lead" },
      attributes: { "example.role": "coordinator" },
      ...extra,
    });
    const span = (key: string, extra: Record<string, unknown> = {}) => ({
      key,
      parentKey: key === "root" ? null : "root",
      name: key,
      start: 1_800_000_000_000,
      end: 1_800_000_400_000,
      ...extra,
    });
    const trace = (spans: unknown[]) => ({ key: KEY, ended: false, spans: [span("root"), ...spans] });

    it("joins the trace through the thread that started the workflow", async () => {
      const { histories, emit, tick, spans, sent, clock, claim, report } = await setup({
        threads,
        workflows: { metadata, view: () => view("succeeded") },
      });
      // The provider claims the thread that started the workflow, not its workers.
      await claim({ [THREAD]: origin() });
      await report(trace([span("step-1")]));
      histories['thr_w1'] = new History();
      must(histories['thr_w1'], "thr_w1").turn();
      await emit("thread.idle", "thr_w1");

      const agent = must(spans()[0], "agent span");
      expect(agent.traceId).toBe(providerTraceId(P, KEY));
      // The worker's place is its workflow call.
      expect(agent.parentSpanId).toBe(workflowCallSpanId(WF, "call_0"));
      expect(attr(agent, "example.run_id")).toBe(KEY);
      // It takes the trace from the origin thread, not that thread's agent or attributes.
      expect(agent.name).toBe("invoke_agent claude-code");
      expect(attr(agent, "bb.agent.id")).toBeUndefined();
      expect(attr(agent, "example.role")).toBeUndefined();
      // Inside a trace that names a pipeline, that is the pipeline.
      expect(attr(agent, "gen_ai.pipeline.name")).toBe("feature");
      expect(attr(agent, "bb.workflow.name")).toBe("review-changes");

      // The workflow just finished and no span of the trace names it yet: wait for that link.
      clock.now = 1_800_000_030_000 + 60_000;
      const before = sent.length;
      await tick();
      expect(sent).toHaveLength(before);
      await report(trace([span("step-1", { workflowRunId: WF })]));
      await tick();
      expect(sent).toHaveLength(before + 1);
      const root = must(sent.at(-1)?.spans[0], "root span");
      expect(root.name).toBe("invoke_workflow review-changes");
      expect(root.traceId).toBe(providerTraceId(P, KEY));
      expect(root.parentSpanId).toBe(providerSpanId(P, KEY, "step-1"));
      expect(attr(root, "example.run_id")).toBe(KEY);
      expect(attr(root, "gen_ai.pipeline.name")).toBe("feature");
    });

    it("hangs the workflow under a span that names its script, without waiting", async () => {
      const { histories, emit, tick, sent, clock, claim, report } = await setup({
        threads,
        workflows: { metadata, view: () => view("succeeded") },
      });
      await claim({ [THREAD]: origin() });
      // A provider that writes the script knows its name before the run has an id.
      await report(trace([span("step-1", { workflowName: "review-changes" })]));
      histories['thr_w1'] = new History();
      must(histories['thr_w1'], "thr_w1").turn();
      await emit("thread.idle", "thr_w1");
      clock.now = 1_800_000_030_000 + 1_000;
      await tick();
      const root = sent.at(-1)!.spans.find((span) => span.name.startsWith("invoke_workflow"))!;
      expect(root.parentSpanId).toBe(providerSpanId(P, KEY, "step-1"));
    });

    it("hangs the workflow where its origin thread hangs when no span ever names it", async () => {
      const { histories, emit, tick, sent, clock, claim, report } = await setup({
        threads,
        workflows: { metadata, view: () => view("succeeded") },
      });
      await claim({ [THREAD]: origin({ parent: "subtask-ENG-8" }) });
      await report(trace([span("subtask-ENG-8")]));
      histories['thr_w1'] = new History();
      must(histories['thr_w1'], "thr_w1").turn();
      await emit("thread.idle", "thr_w1");
      clock.now = 1_800_000_030_000 + 11 * 60_000;
      await tick();
      const root = sent.at(-1)!.spans.find((span) => span.name.startsWith("invoke_workflow"))!;
      expect(root.parentSpanId).toBe(providerSpanId(P, KEY, "subtask-ENG-8"));
    });

    it("waits for the trace's first snapshot rather than placing the workflow for good", async () => {
      const { histories, emit, tick, sent, clock, claim, report } = await setup({
        threads,
        workflows: { metadata, view: () => view("succeeded") },
      });
      await claim({ [THREAD]: origin({ parent: "subtask-ENG-8" }) });
      histories['thr_w1'] = new History();
      must(histories['thr_w1'], "thr_w1").turn();
      await emit("thread.idle", "thr_w1");
      const workflowRoots = () =>
        sent.flatMap((request) => request.spans).filter((span) => span.name.startsWith("invoke_workflow"));
      clock.now = 1_800_000_030_000 + 60_000;
      await tick();
      expect(workflowRoots()).toEqual([]);
      await report(trace([span("step-1", { workflowRunId: WF })]));
      await tick();
      expect(must(workflowRoots()[0], "workflow root").parentSpanId).toBe(providerSpanId(P, KEY, "step-1"));
    });

    it("names a worker after the agent its provider claims it as", async () => {
      const { histories, emit, tick, spans, sent, clock, claim, report } = await setup({
        threads,
        workflows: { metadata, view: () => view("succeeded") },
      });
      await claim({
        [THREAD]: origin(),
        // The provider can claim the worker itself, to name its agent.
        thr_w1: { trace: { key: KEY, pipeline: "feature" }, agent: { id: "developer", name: "Senior Dev" } },
      });
      await report(trace([span("step-1", { workflowRunId: WF })]));
      histories['thr_w1'] = new History();
      must(histories['thr_w1'], "thr_w1").turn();
      await emit("thread.idle", "thr_w1");
      const agent = must(spans()[0], "agent span");
      const tools = spans().filter((span) => span.name.startsWith("execute_tool"));
      expect(agent.name).toBe("invoke_agent Senior Dev");
      expect(attr(agent, "gen_ai.agent.name")).toBe("Senior Dev");
      expect(attr(agent, "bb.agent.id")).toBe("developer");
      expect(new Set(tools.map((span) => attr(span, "gen_ai.agent.name")))).toEqual(new Set(["Senior Dev"]));
      // Named, and still placed under its workflow call.
      expect(agent.parentSpanId).toBe(workflowCallSpanId(WF, "call_0"));

      clock.now = 1_800_000_030_000 + 60_000;
      await tick();
      const calls = sent.at(-1)!.spans.filter((span) => span.name.startsWith("workflow.call"));
      expect(calls.map((span) => attr(span, "bb.agent.id"))).toEqual(["developer", undefined, undefined]);
      expect(attr(must(calls[0], "first call span"), "bb.agent.name")).toBe("Senior Dev");
    });
  });

  describe("with Workflows disabled or removed", () => {
    const quietly = async (options: Setup) => {
      const ctx = await setup(options);
      await ctx.claim({ [THREAD]: { trace: { key: KEY } } });
      for (const id of WORKERS) ctx.histories[id] = new History();
      for (let round = 0; round < 3; round++) {
        for (const id of WORKERS) {
          must(ctx.histories[id], id).turn();
          await ctx.emit("thread.idle", id);
        }
        ctx.clock.now += 6 * 60_000;
        await ctx.tick();
      }
      return ctx;
    };
    const expectOwnTraces = async (ctx: Awaited<ReturnType<typeof quietly>>) => {
      const agents = ctx.spans().filter((span) => span.name.startsWith("invoke_agent"));
      // Every turn went out when its thread went idle, each as its own trace.
      expect(agents).toHaveLength(6);
      expect(new Set(agents.map((span) => span.traceId)).size).toBe(6);
      for (const span of ctx.spans()) {
        expect(span.traceId).not.toBe(workflowTraceId(WF));
        expect(span.traceId).not.toBe(providerTraceId(P, KEY));
        expect(attr(span, "bb.workflow.run_id")).toBeUndefined();
      }
      expect(await ctx.bb.storage.kv.list("workflow:")).toEqual([]);
      expect(await ctx.bb.storage.kv.list("retry:")).toEqual([]);
      const logs = ctx.harness.inspection.logEntries;
      expect(logs.filter((entry) => entry.level === "warn" || entry.level === "error")).toEqual([]);
      // Said once, not once for every worker or every tick.
      expect(logs.filter((entry) => entry.message.includes("Workflows")).length).toBeLessThanOrEqual(1);
    };

    it("exports workers as their own threads when Workflows does not answer", async () => {
      // The metadata is still in bb's thread record; the plugin that answers for it is gone.
      await expectOwnTraces(await quietly({ threads, workflows: { metadata, view: () => { throw new Error("no such plugin"); } } }));
    });

    it("exports workers as their own threads when their Workflows metadata cannot be read", async () => {
      await expectOwnTraces(await quietly({ threads, metadataFails: true }));
    });
  });
});

describe("bb sentry-traces", () => {
  it("status shows the project but never the key", async () => {
    const { harness, history, emit } = await setup();
    history.turn();
    await emit("thread.idle");
    const text = await harness.behavior.runCli(["status"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Sending: yes");
    expect(text.stdout).toContain("o42.ingest.us.sentry.io, project 4500000000000001");
    expect(text.stdout).toContain("Sent: 1 turns");
    expect(text.stdout).not.toContain("0123456789abcdef");
    const json: unknown = JSON.parse((await harness.behavior.runCli(["status", "--json"])).stdout);
    expect(json).toMatchObject({
      enabled: true,
      sending: true,
      captureContent: false,
      dsn: { configured: true, projectId: "4500000000000001" },
      stats: { turnsSent: 1 },
    });
    expect(JSON.stringify(json)).not.toContain("0123456789abcdef");
  });

  it("status says what to do when nothing is configured", async () => {
    const { harness } = await setup({ settings: { dsn: "", enabled: false } });
    const result = await harness.behavior.runCli(["status"]);
    expect(result.stdout).toContain("Sending: no");
    expect(result.stdout).toContain("bb plugin config sentry-traces set dsn <dsn>");
  });

  it("test sends one synthetic trace, even while export is off", async () => {
    const { harness, sent } = await setup({ settings: { enabled: false } });
    const result = await harness.behavior.runCli(["test"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Trace id: [0-9a-f]{32}/);
    expect(sent).toHaveLength(1);
    expect(names(must(sent[0], "request").spans)).toEqual([
      "invoke_agent bb-sentry-traces-test",
      "chat claude-sonnet-4-5",
      "execute_tool shell",
      "execute_tool Agent",
      "invoke_agent bb-sentry-traces-test-helper",
      "chat claude-sonnet-4-5",
    ]);
    expect(must(sent[0], "request").spans.every((span) => attr(span, "bb.synthetic") === true)).toBe(true);
  });

  it("test fails clearly without a DSN or when Sentry refuses", async () => {
    const missing = await setup({ settings: { dsn: "" } });
    const noDsn = await missing.harness.behavior.runCli(["test"]);
    expect(noDsn.exitCode).not.toBe(0);
    expect(noDsn.stderr).toContain("No DSN is set.");
    const refused = await setup({ respond: () => 403 });
    const result = await refused.harness.behavior.runCli(["test"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Sentry answered 403");
  });

  it("export prints the OTLP JSON without sending or recording anything", async () => {
    const { bb, harness, history, sent } = await setup();
    history.turn();
    history.turn();
    const result = await harness.behavior.runCli(["export", THREAD, "--all"]);
    expect(result.exitCode).toBe(0);
    const spans = exportedSpans(result.stdout);
    expect(spans.filter((span) => span.name.startsWith("invoke_agent"))).toHaveLength(2);
    expect(result.stdout).not.toContain(SECRETS.prompt);
    expect(sent).toHaveLength(0);
    expect(await bb.storage.kv.list()).toEqual([]);

    const withContent = await harness.behavior.runCli(["export", "--content", "--summary"], {
      threadId: THREAD,
    });
    expect(withContent.stdout).toContain("1 turns");
    expect(withContent.stdout).toContain("execute_tool shell");
  });

  it("export can include the turn in progress, and the whole thread's usage", async () => {
    const { harness, history } = await setup();
    history.turn();
    history.request("req-open").start("turn-open", "req-open");
    history.item("turn-open", { type: "commandExecution", id: "open-c1", command: "ls" }, 100);
    history.usage(CLAUDE_TOTAL);

    const finished = await harness.behavior.runCli(["export", THREAD, "--all"]);
    expect(finished.stdout).not.toContain("gen_ai.usage.input_tokens");
    const all = await harness.behavior.runCli(["export", THREAD, "--all", "--running"]);
    const spans = exportedSpans(all.stdout);
    expect(spans.filter((span) => span.name.startsWith("invoke_agent"))).toHaveLength(2);
    expect(
      spans.filter((span) =>
        span.attributes.some((attribute) => attribute.key === "gen_ai.usage.input_tokens"),
      ),
    ).toHaveLength(1);
  });

  it("export explains a missing thread", async () => {
    const { harness } = await setup();
    const none = await harness.behavior.runCli(["export"]);
    expect(none.exitCode).not.toBe(0);
    expect(none.stderr).toContain("bb sentry-traces export <thread-id>");
    const unknown = await harness.behavior.runCli(["export", "thr_missing"]);
    expect(unknown.stderr).toContain("No thread with id thr_missing");
  });

  it("export shows the provider trace a claim puts the thread in", async () => {
    const { harness, history, claim } = await setup();
    await claim({ [THREAD]: { trace: { key: KEY } } });
    history.turn();
    const summary = await harness.behavior.runCli(["export", THREAD, "--summary"]);
    expect(summary.stdout).toContain(`${P} trace ${KEY}`);
    expect(summary.stderr).toBe("");
  });

  it("status lists the providers that reported lately, with their threads and open traces", async () => {
    const { harness, clock, claim, report } = await setup();
    const none = await harness.behavior.runCli(["status"]);
    expect(none.stdout).toContain("Trace providers: none reported in the last 30 days");
    await claim({ thr_a: { trace: { key: KEY } }, thr_b: { trace: { key: KEY } } });
    await report({ key: KEY, ended: false, spans: [] });
    await claim({ thr_c: { trace: { key: "other" } } }, "other-provider");
    clock.now += 2 * 60 * 60_000;
    const text = await harness.behavior.runCli(["status"]);
    expect(text.stdout).toContain(`Trace provider ${P}: 2 threads claimed, 1 traces open, last report 2h ago`);
    expect(text.stdout).toContain("Trace provider other-provider: 1 threads claimed, 0 traces open");
    const json = JSON.parse((await harness.behavior.runCli(["status", "--json"])).stdout) as { providers: unknown };
    expect(json.providers).toEqual([
      { provider: P, claimedThreads: 2, openTraces: 1, lastReportAt: clock.now - 2 * 60 * 60_000 },
      { provider: "other-provider", claimedThreads: 1, openTraces: 0, lastReportAt: clock.now - 2 * 60 * 60_000 },
    ]);
    // A provider not heard from in 30 days is not listed.
    clock.now += 31 * 24 * 60 * 60_000;
    expect((await harness.behavior.runCli(["status"])).stdout).toContain("Trace providers: none reported");
  });

  it("loads and exports with a providers setting left from an older version", async () => {
    const { harness, history, emit, spans, rpc } = await setup({ settings: { providers: "example-provider" } });
    history.turn();
    await emit("thread.idle");
    expect(spans().length).toBeGreaterThan(0);
    expect(rpc).not.toHaveBeenCalled();
    expect((await harness.behavior.runCli(["status"])).exitCode).toBe(0);
  });
});

