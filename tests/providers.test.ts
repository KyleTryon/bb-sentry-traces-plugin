import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerSpanId, providerTraceId } from "../src/integrations/providers/spans.js";
import { workflowCallSpanId } from "../src/integrations/workflows/ids.js";
import { attr, History, SECRETS } from "./helpers.js";
import { asPlugin, disposeHosts, KEY, must, names, P, setup, THREAD, turnIndexes } from "./host.js";

afterEach(disposeHosts);

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

    it("refuses a call shaped for another version as that version, not as malformed", async () => {
      const { bb, harness } = await setup();
      const threads = harness.behavior.callRpc("report_threads", { contract: 1, threadIds: [THREAD] }, asPlugin(P));
      await expect(threads).rejects.toMatchObject({ code: "invalid" });
      await expect(threads).rejects.toThrow(/contract 2, not 1/);
      const traces = harness.behavior.callRpc("report_trace", { contract: 1, runId: KEY }, asPlugin(P));
      await expect(traces).rejects.toMatchObject({ code: "invalid" });
      await expect(traces).rejects.toThrow(/contract 2, not 1/);
      expect(await bb.storage.kv.list()).toEqual([]);
    });

    it("refuses a malformed report", async () => {
      const { harness, history, emit, spans } = await setup();
      const bad = { contract: 2, threads: [{ threadId: THREAD, context: { trace: { key: "" } } }] };
      await expect(harness.behavior.callRpc("report_threads", bad, asPlugin(P))).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(
        harness.behavior.callRpc("report_trace", { contract: 2 }, asPlugin(P)),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        harness.behavior.callRpc("report_trace", { contract: 2, trace: trace(true), deleted: { key: KEY } }, asPlugin(P)),
      ).rejects.toMatchObject({ code: "invalid_input" });
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

    it("takes at most 5,000 claims from one provider", async () => {
      const { bb, claim } = await setup();
      for (let n = 0; n < 5_000; n++) {
        await bb.storage.kv.set(`claim:thr_${n}`, { context: { provider: P, traceKey: KEY }, reportedAt: 1 });
      }
      expect((await claim({ thr_new: context(), thr_1: context() })).results).toEqual({ thr_new: "limit", thr_1: "ok" });
      expect((await claim({ thr_new: { trace: { key: "theirs" } } }, "other-provider")).results).toEqual({ thr_new: "ok" });
      expect((await claim({ thr_2: null })).results).toEqual({ thr_2: "ok" });
      expect((await claim({ thr_other: context() })).results).toEqual({ thr_other: "ok" });
      expect((await claim({ thr_more: context() })).results).toEqual({ thr_more: "limit" });
    }, 30_000);

    it("lets go of the claims of a provider that has not reported for 30 days", async () => {
      const { bb, clock, tick, claim, report } = await setup();
      await claim({ thr_quiet: context() });
      await claim({ thr_busy: { trace: { key: "theirs" } } }, "other-provider");
      clock.now += 20 * 24 * 60 * 60_000;
      await report({ key: "theirs", ended: false, spans: [] }, "other-provider");
      clock.now += 11 * 24 * 60 * 60_000;
      await tick();
      expect(await bb.storage.kv.list("claim:")).toEqual(["claim:thr_busy"]);
      expect((await claim({ thr_quiet: { trace: { key: "theirs" } } }, "other-provider")).results).toEqual({
        thr_quiet: "ok",
      });
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

    it("refuses or takes a span the same way whether content capture is on or off", async () => {
      const content = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`gen_ai.input.messages${n}`, "y".repeat(8_000)]));
      // Escaped in storage, each of these takes six bytes.
      const attributes = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`example.a${n}`, "\u0001".repeat(2_000)]));
      for (const captureContent of [false, true]) {
        const { report } = await setup({ settings: { captureContent } });
        await expect(report(trace(true, [span("wide", { content })]))).resolves.toMatchObject({ sending: true });
        await expect(report(trace(true, [span("heavy", { attributes })]))).rejects.toMatchObject({ code: "invalid" });
      }
    });

    it("keeps a span with more content than it may carry, without the content past the cap", async () => {
      const { history, emit, tick, sent, claim, report } = await setup({ settings: { captureContent: true } });
      await claim({ [THREAD]: context() });
      const content = Object.fromEntries(Array.from({ length: 40 }, (_, n) => [`gen_ai.input.messages${n}`, "y".repeat(8_000)]));
      await report(trace(true, [span("wide", { content })]));
      history.turn();
      await emit("thread.idle");
      await tick();
      const wide = must(sent.flatMap((request) => request.spans).find((one) => one.name === "wide"), "the wide span");
      const kept = wide.attributes.filter((one) => one.key.startsWith("gen_ai.input.messages"));
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(40);
      expect(JSON.stringify(kept).length).toBeLessThanOrEqual(48 * 1024 + 1024);
    });

    it("refuses a trace whose text or shared attributes are too large to store, and keeps nothing of it", async () => {
      const { bb, report } = await setup();
      await expect(report({ ...trace(true), pipeline: "x".repeat(300 * 1024) })).rejects.toMatchObject({
        code: "invalid_input",
      });
      for (const field of ["name", "op", "errorType", "workflowName", "workflowRunId"]) {
        await expect(report(trace(true, [span("s", { [field]: "n".repeat(5_000) })]))).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
      const attributes = Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`example.a${n}`, "\u0001".repeat(2_000)]));
      const refused = report({ ...trace(true), attributes });
      await expect(refused).rejects.toMatchObject({ code: "invalid" });
      await expect(refused).rejects.toThrow(/attributes/);
      expect(await bb.storage.kv.list("snapshot")).toEqual([]);
    });

    it("keeps at most 200 snapshots of a provider that no exported turn is in, dropping the oldest", async () => {
      const { bb, history, emit, clock, claim, report } = await setup();
      await claim({ [THREAD]: context() });
      await report(trace(false));
      history.turn();
      await emit("thread.idle");
      for (let n = 0; n < 205; n++) {
        clock.now += 1_000;
        await report({ key: `other-${n}`, ended: false, spans: [] });
      }
      await report({ key: "elsewhere", ended: false, spans: [] }, "other-provider");
      const keys = await bb.storage.kv.list("snapshot:");
      expect(keys.filter((key) => key.startsWith(`snapshot:${P}/other-`))).toHaveLength(200);
      expect(keys).not.toContain(`snapshot:${P}/other-4`);
      expect(keys).toContain(`snapshot:${P}/other-5`);
      // The trace a turn was sent into is kept, and so is another provider's.
      expect(keys).toContain(`snapshot:${P}/${KEY}`);
      expect(keys).toContain("snapshot:other-provider/elsewhere");
    }, 30_000);

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
