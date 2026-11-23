/**
 * Edge cases of the export loop: turns that never finish, the plugin turned
 * off and on, settings changed or the plugin unloaded mid-export, retries,
 * storage limits and pruning.
 */
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RETRY_ATTEMPTS, MAX_RETRY_ENTRIES, MAX_RUN_ENTRIES } from "../src/export/constants.js";
import { scheduleCheck } from "../src/export/retries.js";
import { noteTrace } from "../src/export/runs.js";
import type { ExportContext, RetryEntry, TraceEntry } from "../src/export/types.js";
import { TraceBuilder } from "../src/core/trace/builder.js";
import { ProviderStore } from "../src/integrations/providers/store.js";
import type { TraceContext } from "../src/integrations/providers/types.js";
import type { OtlpSpan, OtlpTraces } from "../src/core/otlp.js";
import { createPlugin } from "../src/server.js";
import { attr, DSN, eventsList, History, SECRETS } from "./helpers.js";

const THREAD = "thr_one";
const OTHER_DSN = "https://fedcba9876543210fedcba9876543210@o42.ingest.us.sentry.io/4500000000000002";
const P = "example-provider";
const DAY = 24 * 60 * 60_000;

interface Post {
  url: string;
  spans: OtlpSpan[];
}

interface Setup {
  settings?: Record<string, string | boolean>;
  /** Answers each post; may change the world before it answers. */
  respond?: (post: Post) => number | Promise<number>;
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()!();
});

async function setup(options: Setup = {}) {
  const histories: Record<string, History> = { [THREAD]: new History() };
  const clock = { now: 1_800_000_500_000 };
  const posts: Post[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string) as OtlpTraces;
    const post = { url: String(url), spans: body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)) };
    const status = (await options.respond?.(post)) ?? 200;
    if (status === 200) posts.push(post);
    return new Response(status === 200 ? "{}" : "nope", { status });
  }) as typeof fetch;
  const rpc = vi.fn(async ({ pluginId }: { pluginId: string }) => {
    throw new Error(`plugin ${pluginId} is not installed`);
  });
  const thread = (id: string) =>
    makeThreadResponse({ id, title: SECRETS.title, providerId: "claude-code", projectId: "proj_1" });
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
        getPluginMetadata: async () => ({}),
      },
      plugins: { callRpc: rpc },
    },
  });
  await createPlugin({ fetch: fetchImpl, now: () => clock.now })(bb);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await harness.lifecycle.dispose();
  };
  disposers.push(dispose);

  /** Lets queued work settle: no new bb call or post for a few rounds. */
  const settle = async () => {
    for (let quiet = 0, last = -1; quiet < 3; ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const calls = harness.inspection.sdk.calls.length + posts.length;
      quiet = calls === last ? quiet + 1 : 0;
      last = calls;
    }
  };
  const emit = async (event: "thread.idle" | "thread.active", id = THREAD) => {
    if (event === "thread.idle") {
      await harness.behavior.emitThreadEvent(event, { thread: thread(id), lastAssistantText: null });
    } else {
      await harness.behavior.emitThreadEvent(event, { thread: thread(id) });
    }
    await settle();
  };
  const tick = async () => {
    const service = harness.behavior.runService("export-retry");
    service.controller.abort();
    await service.done;
  };
  const setSettings = async (values: Record<string, string | boolean | null>) => {
    await harness.behavior.setSettings(values);
    await settle();
  };
  const spans = () => posts.flatMap((post) => post.spans);
  const caller = { experimental_caller: { kind: "plugin" as const, pluginId: P } };
  /** The provider claims threads for traces of its own. */
  const claim = (threads: Record<string, unknown>) =>
    harness.behavior.callRpc(
      "report_threads",
      { contract: 2, threads: Object.entries(threads).map(([threadId, context]) => ({ threadId, context })) },
      caller,
    );
  /** The provider reports a trace's snapshot. */
  const report = (trace: unknown) => harness.behavior.callRpc("report_trace", { contract: 2, trace }, caller);
  const history = histories[THREAD]!;
  return { bb, harness, histories, history, clock, posts, spans, emit, tick, setSettings, dispose, claim, report };
}

const agentSpans = (spans: OtlpSpan[]) => spans.filter((span) => span.name.startsWith("invoke_agent"));
const turnIndexes = (spans: OtlpSpan[]) => agentSpans(spans).map((span) => attr(span, "bb.turn.index"));

/** A finished turn of `items` commands. */
function turnOf(h: History, turnId: string, items: number) {
  h.request(`${turnId}-req`).start(turnId, `${turnId}-req`);
  for (let index = 0; index < items; index++) {
    h.item(turnId, { type: "commandExecution", id: `${turnId}-${index}`, command: "ls" }, 1);
  }
  h.complete(turnId);
}

/** A turn that starts and runs a command, then never says it ended. */
function crashedTurn(h: History, turnId: string) {
  h.request(`${turnId}-req`).start(turnId, `${turnId}-req`);
  h.push("item/started", { item: { type: "commandExecution", id: `${turnId}-c`, command: "ls", status: "pending" } }, turnId);
}

/** A turn that starts a background subagent which is still working when the turn ends. */
function backgroundTurn(h: History, turnId: string) {
  h.request(`${turnId}-req`).start(turnId, `${turnId}-req`);
  const call = { type: "toolCall", id: `${turnId}-agent`, tool: "Agent", arguments: { run_in_background: true } };
  h.push("item/started", { item: { ...call, status: "pending" } }, turnId);
  h.push("item/completed", { item: { ...call, status: "completed" } }, turnId);
  const task = { type: "backgroundTask", id: `${turnId}-task`, taskType: "local_agent", parentToolCallId: call.id };
  h.push("item/backgroundTask/progress", { item: { ...task, status: "pending" } }, turnId);
  h.complete(turnId);
}

const TOTAL = {
  totalTokens: 1_000,
  inputTokens: 100,
  cachedInputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 900,
  reasoningOutputTokens: 0,
};
const inputTokens = (spans: OtlpSpan[]) =>
  spans.map((span) => attr(span, "gen_ai.usage.input_tokens")).filter((value) => value !== undefined);

describe("a turn that never finishes", () => {
  it("is closed as interrupted when the next top-level turn starts, and does not hold the read back", async () => {
    const { harness, history: h, emit, spans } = await setup();
    h.turn();
    await emit("thread.idle");
    crashedTurn(h, "crashed");
    h.wait(60_000);
    h.turn();
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([1, 2, 3]);
    const crashed = agentSpans(spans()).find((span) => attr(span, "bb.turn.id") === "crashed")!;
    expect(attr(crashed, "bb.turn.status")).toBe("interrupted");
    // The read after the turns sent starts past the crashed turn.
    h.turn();
    await emit("thread.idle");
    const reads = harness.inspection.sdk
      .callsTo("threads.events.list")
      .map((args) => Number((args[0] as { afterSeq?: string }).afterSeq ?? -1))
      .filter((afterSeq) => afterSeq >= 0);
    const crashedSeq = h.events.find((event) => event.type === "turn/started" && event.scope.turnId === "crashed")!.seq;
    expect(reads.at(-1)).toBeGreaterThan(crashedSeq);
    expect(turnIndexes(spans())).toEqual([1, 2, 3, 4]);
  });

  it("does not stop the newest turns being sent once a long history piles up after it", async () => {
    const { history: h, emit, spans } = await setup();
    h.turn();
    await emit("thread.idle");
    crashedTurn(h, "crashed");
    // More events than one read takes, in turns of a few events each.
    for (let n = 0; n < 7_000; n++) turnOf(h, `short-${n}`, 1);
    await emit("thread.idle");
    h.turn();
    await emit("thread.idle");
    expect(turnIndexes(spans()).slice(-2)).toEqual([7_002, 7_003]);
  }, 60_000);

  it("is interrupted once its own last event is hours old, though later events keep the thread busy", () => {
    const h = new History();
    backgroundTurn(h, "t1");
    crashedTurn(h, "t2");
    h.wait(7 * 60 * 60_000);
    // The first turn's background agent still reports.
    h.push("item/backgroundTask/progress", {
      item: { type: "backgroundTask", id: "t1-task", taskType: "local_agent", parentToolCallId: "t1-agent", status: "pending" },
    });
    const builder = new TraceBuilder({ content: false });
    builder.apply(h.events);
    const [first, second] = builder.snapshot(h.now + 60_000);
    expect(second?.status).toBe("interrupted");
    expect(second?.end).not.toBeNull();
    // The finished turn's background agent is still working.
    expect(first?.status).toBe("completed");
    expect(first?.spans.some((span) => span.kind === "subagent" && span.end === null)).toBe(true);
  });

  it("is not closed by a subagent's turn starting", () => {
    const h = new History();
    h.request("r").start("t1", "r");
    const call = { type: "toolCall", id: "agent-1", tool: "Agent", arguments: {} };
    h.push("item/started", { item: { ...call, status: "pending" } }, "t1");
    h.push("turn/started", { parentToolCallId: "agent-1" }, "sub");
    const builder = new TraceBuilder({ content: false });
    builder.apply(h.events);
    expect(builder.snapshot(h.now)[0]?.end).toBeNull();
  });
});

describe("turning sending off and on again", () => {
  it.each([
    ["enabled", { enabled: false }, { enabled: true }],
    ["the DSN", { dsn: "" }, { dsn: DSN }],
  ] as const)("sends only turns that finish from then on (%s)", async (_name, off, on) => {
    const { history: h, clock, emit, spans, setSettings } = await setup();
    // The thread's events and the plugin's clock move on together.
    const later = (ms: number) => {
      h.wait(Math.max(0, clock.now - h.now) + ms);
      clock.now = h.now;
    };
    later(1_000);
    await emit("thread.active");
    h.turn();
    h.usage(TOTAL);
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([1]);

    later(60_000);
    await setSettings(off);
    for (let n = 0; n < 3; n++) {
      later(60_000);
      h.turn();
      h.usage({ ...TOTAL, inputTokens: 100 + (n + 1) * 1_000 });
      await emit("thread.idle");
    }
    later(60_000);
    await setSettings(on);
    later(1_000);
    await emit("thread.active");
    h.turn();
    clock.now = h.now;
    h.usage({ ...TOTAL, inputTokens: 3_150 });
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([1, 5]);
    // The new turn carries only its own tokens, not the gap's.
    expect(inputTokens(spans())).toEqual([100, 50]);
  });

  it("does not send a turn of the gap left waiting for a retry", async () => {
    let status = 503;
    const { bb, history: h, emit, tick, clock, spans, setSettings } = await setup({ respond: () => status });
    h.turn();
    await emit("thread.idle");
    expect(await bb.storage.kv.list("retry:")).toEqual([`retry:${THREAD}`]);
    await setSettings({ enabled: false });
    status = 200;
    h.turn();
    clock.now += 2 * 60_000;
    await setSettings({ enabled: true });
    await tick();
    expect(spans()).toHaveLength(0);
    h.turn();
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([3]);
  });
});

describe("settings changed during an export", () => {
  it("stops sending once sending is turned off, keeping what was sent", async () => {
    let posts = 0;
    let harness: Awaited<ReturnType<typeof setup>>["harness"] | null = null;
    const ctx = await setup({
      respond: async () => {
        if (++posts === 2) await harness!.behavior.setSettings({ enabled: false });
        return 200;
      },
    });
    harness = ctx.harness;
    const { bb, history: h, emit, spans } = ctx;
    h.turn();
    await emit("thread.idle");
    h.turn();
    h.turn();
    h.turn();
    await emit("thread.idle");
    expect(turnIndexes(spans())).toEqual([1, 2]);
    expect(await bb.storage.kv.get(`thread:${THREAD}`)).toMatchObject({ sentTurn: 2 });
    expect(await bb.storage.kv.get("stats")).toMatchObject({ failures: 0 });
  });

  it("sends the rest to the new DSN, not the old one", async () => {
    let posts = 0;
    let harness: Awaited<ReturnType<typeof setup>>["harness"] | null = null;
    const ctx = await setup({
      respond: async () => {
        if (++posts === 2) await harness!.behavior.setSettings({ dsn: OTHER_DSN });
        return 200;
      },
    });
    harness = ctx.harness;
    const { history: h, emit, tick, posts: sent } = ctx;
    h.turn();
    await emit("thread.idle");
    h.turn();
    h.turn();
    await emit("thread.idle");
    expect(sent.map((post) => post.url.includes("4500000000000002"))).toEqual([false, false]);
    await tick();
    expect(sent.map((post) => post.url.includes("4500000000000002"))).toEqual([false, false, true]);
    expect(turnIndexes(ctx.spans())).toEqual([1, 2, 3]);
  });
});

describe("unloading during an export", () => {
  it("stops between turns, and waits for the export to save what it sent", async () => {
    let posts = 0;
    const unload: { done: Promise<void> | null } = { done: null };
    let dispose: (() => Promise<void>) | null = null;
    const writes: string[] = [];
    let writesBefore = 0;
    const ctx = await setup({
      respond: () => {
        if (++posts === 2) {
          writesBefore = writes.length;
          unload.done = dispose!();
        }
        return 200;
      },
    });
    dispose = ctx.dispose;
    const set = ctx.bb.storage.kv.set.bind(ctx.bb.storage.kv);
    vi.spyOn(ctx.bb.storage.kv, "set").mockImplementation(async (key, value) => {
      writes.push(key);
      await set(key, value);
    });
    const { history: h, emit, spans } = ctx;
    h.turn();
    await emit("thread.idle");
    h.turn();
    h.turn();
    await ctx.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: THREAD, providerId: "claude-code", projectId: "proj_1" }),
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(unload.done).not.toBeNull());
    await unload.done;
    // What was sent is saved before unloading is over, and the turn after it waits.
    expect(writes.slice(writesBefore)).toContain(`thread:${THREAD}`);
    expect(turnIndexes(spans())).toEqual([1, 2]);
  });
});

describe("retries", () => {
  it("keeps checking a waiting turn after Sentry refuses the key", async () => {
    let status = 200;
    const { bb, history: h, emit, clock } = await setup({ respond: () => status });
    backgroundTurn(h, "t1");
    await emit("thread.idle");
    h.turn();
    status = 401;
    await emit("thread.idle");
    const retry = await bb.storage.kv.get<RetryEntry>(`retry:${THREAD}`);
    expect(retry).toBeDefined();
    expect(retry!.nextAt).toBeGreaterThan(clock.now);
  });

  it("starts counting failures afresh after a successful send", async () => {
    let status = 503;
    const { bb, history: h, emit, tick, clock } = await setup({ respond: () => status });
    status = 200;
    backgroundTurn(h, "t1");
    await emit("thread.idle");
    status = 503;
    h.turn();
    await emit("thread.idle");
    expect(await bb.storage.kv.get(`retry:${THREAD}`)).toMatchObject({ attempts: 1 });
    status = 200;
    clock.now += 2 * 60_000;
    await tick();
    expect(await bb.storage.kv.get(`retry:${THREAD}`)).toMatchObject({ attempts: 0 });
  });

  it("keeps checking a waiting turn after giving up retrying", async () => {
    const { bb, history: h, emit, tick } = await setup({ respond: () => 503 });
    backgroundTurn(h, "t1");
    await emit("thread.idle");
    h.turn();
    await emit("thread.idle");
    await bb.storage.kv.set(`retry:${THREAD}`, { attempts: MAX_RETRY_ATTEMPTS, nextAt: 0 } satisfies RetryEntry);
    await tick();
    expect(await bb.storage.kv.get(`retry:${THREAD}`)).toBeDefined();
  });
});

/** An export context over plain in-memory storage, for the storage-only functions. */
function memoryContext(now: () => number) {
  const store = new Map<string, unknown>();
  const kv = {
    get: async <T>(key: string) => store.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      store.set(key, structuredClone(value));
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    list: async (prefix = "") => [...store.keys()].filter((key) => key.startsWith(prefix)),
  };
  const log = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
  const providers = new ProviderStore(kv, now);
  const ctx = { bb: { storage: { kv }, log }, now, locks: new Map(), migrated: true, disposed: false, providers };
  return { store, ctx: ctx as unknown as ExportContext };
}

describe("storage limits", () => {
  it("drops runs already sent before one still open", async () => {
    let now = 1_000;
    const { store, ctx } = memoryContext(() => now);
    const traceOf = (key: string) =>
      ({ provider: P, traceKey: key, pipeline: null, traceAttributes: {}, parentKey: "root" }) as unknown as TraceContext;
    await noteTrace(ctx, traceOf("long-open"));
    for (let n = 0; n < MAX_RUN_ENTRIES; n++) {
      now += 1_000;
      await noteTrace(ctx, traceOf(`short-${n}`));
      const key = `trace:${P}/short-${n}`;
      store.set(key, { ...(store.get(key) as TraceEntry), sentAt: now });
    }
    expect(store.has(`trace:${P}/long-open`)).toBe(true);
    expect([...store.keys()].filter((key) => key.startsWith("trace:"))).toHaveLength(MAX_RUN_ENTRIES);
  });

  it("drops the retries that failed most, not the checks due soonest", async () => {
    const now = 1_000_000;
    const { store, ctx } = memoryContext(() => now);
    store.set("retry:failing", { attempts: 7, nextAt: now + 60 * 60_000 } satisfies RetryEntry);
    for (let n = 0; n < MAX_RETRY_ENTRIES; n++) await scheduleCheck(ctx, `waiting-${n}`, now);
    expect(store.has("retry:failing")).toBe(false);
    expect(store.has("retry:waiting-0")).toBe(true);
    expect(store.has(`retry:waiting-${MAX_RETRY_ENTRIES - 1}`)).toBe(true);
  });
});

describe("the sweep", () => {
  const context = (key: string) => ({ trace: { key, pipeline: "feature", attributes: {} } });
  const root = (key: string) => ({ key: "root", parentKey: null, name: `run ${key}`, start: 1_800_000_000_000, end: 1_800_000_400_000 });

  it("goes on past an entry it cannot save, and does not send that entry again", async () => {
    const { bb, histories, history: h, emit, tick, posts, claim, report } = await setup();
    await claim({ [THREAD]: context("k1"), thr_two: context("k2") });
    histories["thr_two"] = new History();
    h.turn();
    histories["thr_two"].turn();
    await emit("thread.idle");
    await emit("thread.idle", "thr_two");
    const set = bb.storage.kv.set.bind(bb.storage.kv);
    vi.spyOn(bb.storage.kv, "set").mockImplementation(async (key, value) => {
      if (key === `trace:${P}/k1`) throw new Error("value too large");
      await set(key, value);
    });
    for (const key of ["k1", "k2"]) await report({ key, ended: true, spans: [root(key)] });
    const before = posts.length;
    await tick();
    const roots = () => posts.slice(before).flatMap((post) => post.spans).filter((span) => span.name.startsWith("run "));
    expect(roots().map((span) => span.name).sort()).toEqual(["run k1", "run k2"]);
    await tick();
    expect(roots()).toHaveLength(2);
  });

  it("keeps the keys of spans sent early within what storage takes, and sends each span once", async () => {
    const keys = Array.from({ length: 1_999 }, (_, n) => `${String(n).padStart(4, "0")}-${"k".repeat(190)}`);
    const { bb, history: h, emit, tick, posts, claim, report } = await setup();
    const trace = (ended: boolean) => ({
      key: "big",
      ended,
      spans: [
        root("big"),
        ...keys.map((k) => ({ key: k, parentKey: "root", name: "step", start: 1_800_000_100_000, end: 1_800_000_200_000, final: true })),
      ],
    });
    await claim({ [THREAD]: context("big") });
    await report(trace(false));
    h.turn();
    await emit("thread.idle");
    const before = posts.length;
    await tick();
    await tick();
    const entry = await bb.storage.kv.get<TraceEntry>(`trace:${P}/big`);
    expect(entry?.sentKeys?.length).toBeGreaterThan(0);
    expect(entry?.sentKeys?.length).toBeLessThan(keys.length);
    await report(trace(true));
    await tick();
    const steps = posts.slice(before).flatMap((post) => post.spans).filter((span) => span.name === "step");
    expect(steps).toHaveLength(keys.length);
    expect(new Set(steps.map((span) => span.spanId)).size).toBe(keys.length);
  }, 30_000);
});

describe("pruning", () => {
  it("drops threads untouched for 90 days, at most once a day, keeping those with a retry", async () => {
    const { bb, tick, clock } = await setup();
    const old = clock.now - 91 * DAY;
    const state = (updatedAt: number) => ({ sentTurn: 1, resumeSeq: 5, turnsBefore: 1, usage: null, usageKnown: true, updatedAt });
    await bb.storage.kv.set("thread:old", state(old));
    await bb.storage.kv.set("thread:retrying", state(old));
    await bb.storage.kv.set("retry:retrying", { attempts: 1, nextAt: clock.now + DAY } satisfies RetryEntry);
    await bb.storage.kv.set("thread:recent", state(clock.now - DAY));
    await tick();
    expect((await bb.storage.kv.list("thread:")).sort()).toEqual(["thread:recent", "thread:retrying"]);
    await bb.storage.kv.set("thread:later", state(old));
    clock.now += 60 * 60_000;
    await tick();
    expect(await bb.storage.kv.list("thread:")).toContain("thread:later");
    clock.now += DAY;
    await tick();
    expect(await bb.storage.kv.list("thread:")).not.toContain("thread:later");
  });
});

describe("pruning what providers reported", () => {
  it("drops claims of threads untouched for 90 days, even while export is off", async () => {
    const { bb, tick, clock, claim } = await setup({ settings: { enabled: false } });
    await claim({ thr_old: { trace: { key: "k" } }, thr_busy: { trace: { key: "k" } } });
    clock.now += 91 * DAY;
    await bb.storage.kv.set("thread:thr_busy", { sentTurn: 1, resumeSeq: 5, turnsBefore: 1, usage: null, usageKnown: true, updatedAt: clock.now - DAY });
    await claim({ thr_new: { trace: { key: "k" } } });
    await tick();
    expect((await bb.storage.kv.list("claim:")).sort()).toEqual(["claim:thr_busy", "claim:thr_new"]);
  });

  it("drops snapshots no trace needs after 30 days, parts and all, and forgets quiet providers", async () => {
    const { bb, tick, clock, report } = await setup();
    await report({ key: "orphan", ended: false, spans: [{ key: "a", name: "a", start: 1, end: 2 }] });
    // Left by a write that stopped part way.
    await bb.storage.kv.set(`snapshot-part:${(clock.now - 2 * 60 * 60_000).toString(36)}-deadbeef:0`, []);
    await tick();
    // The stray part goes; the snapshot, still young, keeps its own.
    expect(await bb.storage.kv.list("snapshot:")).toHaveLength(1);
    expect(await bb.storage.kv.list("snapshot-part:")).toHaveLength(1);
    clock.now += 31 * DAY;
    await tick();
    expect(await bb.storage.kv.list("snapshot")).toEqual([]);
    expect(await bb.storage.kv.list("provider:")).toEqual([]);
  });
});

describe("a long gap", () => {
  it("counts the turns it skips in the turns its usage covers", async () => {
    const { history: h, emit, spans } = await setup();
    await emit("thread.active");
    h.turn();
    h.usage(TOTAL);
    await emit("thread.idle");
    // Thirty turns finish while no export runs.
    for (let n = 0; n < 30; n++) h.turn();
    h.usage({ ...TOTAL, inputTokens: 5_000 });
    await emit("thread.idle");
    const withUsage = spans().filter((span) => attr(span, "gen_ai.usage.input_tokens") === 4_900);
    expect(withUsage).toHaveLength(1);
    expect(attr(withUsage[0]!, "bb.usage.turns")).toBe(30);
  });
});
