import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attr, SECRETS } from "./helpers.js";
import {
  agentTurns,
  backgroundTurn,
  CLAUDE_TOTAL,
  disposeHosts,
  exportedSpans,
  KEY,
  must,
  names,
  P,
  setup,
  THREAD,
  turnIndexes,
  turnOf,
} from "./host.js";

afterEach(disposeHosts);

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

  it("sends an agent's own cost when it reports no tokens, once per stretch", async () => {
    const { history, emit, spans } = await setup();
    await emit("thread.active");
    history.turn();
    history.cost(0.25);
    await emit("thread.idle");
    history.turn();
    history.cost(0.4);
    await emit("thread.idle");

    const costs = spans()
      .map((span) => attr(span, "gen_ai.cost.total_tokens"))
      .filter((value) => value !== undefined);
    expect(costs).toHaveLength(2);
    expect(costs[0]).toBeCloseTo(0.25);
    expect(costs[1]).toBeCloseTo(0.15);
    expect(spans().some((span) => attr(span, "gen_ai.usage.input_tokens") !== undefined)).toBe(false);
  });

  it("sends no cost in another currency, and none beside token usage", async () => {
    const { history, emit, spans } = await setup();
    await emit("thread.active");
    history.turn();
    history.cost(3, "EUR");
    await emit("thread.idle");
    history.turn();
    history.usage(CLAUDE_TOTAL);
    history.cost(1);
    await emit("thread.idle");

    expect(spans().some((span) => attr(span, "gen_ai.cost.total_tokens") !== undefined)).toBe(false);
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
