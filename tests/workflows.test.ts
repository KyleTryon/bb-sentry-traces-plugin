import { afterEach, describe, expect, it } from "vitest";
import { providerSpanId, providerTraceId } from "../src/integrations/providers/spans.js";
import {
  workflowCallSpanId,
  workflowRootSpanId,
  workflowTraceId,
} from "../src/integrations/workflows/ids.js";
import { attr, History, SECRETS } from "./helpers.js";
import { disposeHosts, KEY, must, names, P, setup, THREAD, type Setup } from "./host.js";

afterEach(disposeHosts);

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

  describe("when Workflows fails for a moment", () => {
    const failure = Object.assign(new Error("HTTP 500: database is locked"), { status: 500, code: "handler_error" });

    it("waits for Workflows to answer again, then places the worker in its run", async () => {
      let failing = true;
      const { bb, histories, emit, tick, spans, clock } = await setup({
        threads,
        workflows: {
          metadata,
          view: () => {
            if (failing) throw failure;
            return view("running");
          },
        },
      });
      histories['thr_w1'] = new History();
      must(histories['thr_w1'], "thr_w1").turn();
      await emit("thread.idle", "thr_w1");
      expect(spans()).toEqual([]);
      expect(await bb.storage.kv.list("retry:")).toEqual(["retry:thr_w1"]);
      failing = false;
      clock.now += 2 * 60_000;
      await tick();
      const agent = must(spans().find((span) => span.name.startsWith("invoke_agent")), "agent span");
      expect(agent.traceId).toBe(workflowTraceId(WF));
      expect(agent.parentSpanId).toBe(workflowCallSpanId(WF, "call_0"));
    });

    it("exports the worker on its own once Workflows has failed for 30 minutes", async () => {
      const { histories, emit, tick, spans, clock } = await setup({
        threads,
        workflows: { metadata, view: () => { throw failure; } },
      });
      histories['thr_w1'] = new History();
      must(histories['thr_w1'], "thr_w1").turn();
      await emit("thread.idle", "thr_w1");
      clock.now += 10 * 60_000;
      await tick();
      expect(spans()).toEqual([]);
      clock.now += 21 * 60_000;
      await tick();
      const agent = must(spans().find((span) => span.name.startsWith("invoke_agent")), "agent span");
      expect(agent.parentSpanId).toBeUndefined();
      expect(attr(agent, "bb.workflow.run_id")).toBeUndefined();
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

    // What bb's `callRpc` throws when the plugin is gone, disabled or lacks the method.
    const absent = {
      removed: Object.assign(new Error('HTTP 404: unknown plugin "workflows"'), { status: 404, code: null }),
      disabled: Object.assign(new Error('HTTP 503: plugin "workflows" is not running (status: disabled)'), {
        status: 503,
        code: null,
      }),
      "without the method": Object.assign(new Error('HTTP 404: plugin "workflows" has no rpc method "workflowRunView"'), {
        status: 404,
        code: "unknown_method",
      }),
    };
    for (const [why, error] of Object.entries(absent)) {
      it(`exports workers as their own threads, at once, when Workflows is ${why}`, async () => {
        // The metadata is still in bb's thread record; the plugin that answers for it is not.
        await expectOwnTraces(await quietly({ threads, workflows: { metadata, view: () => { throw error; } } }));
      });
    }

    it("exports workers as their own threads when their Workflows metadata cannot be read", async () => {
      await expectOwnTraces(await quietly({ threads, metadataFails: true }));
    });
  });
});
