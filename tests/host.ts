/**
 * The whole plugin loaded into a fake bb host, for the tests that drive it
 * end to end: `setup` gives a thread history to write events into, a clock,
 * what reached Sentry, and the calls a provider or bb would make.
 */
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { vi } from "vitest";
import { createPlugin } from "../src/server.js";
import { attr, DSN, eventsList, fakeFetch, History, SECRETS } from "./helpers.js";

export const THREAD = "thr_one";

/** An element an indexed read must have: when it is missing, the test fails and names `label`. */
export function must<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`expected ${label}`);
  return value;
}

export const CLAUDE_TOTAL = {
  totalTokens: 11_000,
  inputTokens: 100,
  cachedInputTokens: 10_000,
  cacheReadInputTokens: 9_000,
  cacheWriteInputTokens: 1_000,
  outputTokens: 900,
  reasoningOutputTokens: 0,
};

export interface Setup {
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
/** Unloads every plugin `setup` loaded. Each test file runs it after each test. */
export async function disposeHosts(): Promise<void> {
  while (disposers.length > 0) await disposers.pop()!();
}

/** The caller a plugin's `bb.sdk.plugins.callRpc` would be. */
export const asPlugin = (pluginId: string) => ({ experimental_caller: { kind: "plugin" as const, pluginId } });

export async function setup(options: Setup = {}) {
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

export const names = (spans: Array<{ name: string }>) => spans.map((span) => span.name);

export const P = "example-provider";
export const KEY = "run_42";
/** A turn that starts a background subagent which is still working when the turn ends. */
export function backgroundTurn(history: History, turnId: string, taskId = `${turnId}-task`) {
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
export const agentTurns = (spans: Array<{ name: string; attributes: unknown }>) =>
  spans
    .filter((span) => span.name.startsWith("invoke_agent") && attr(span as never, "bb.turn.id"))
    .filter((span) => !span.name.includes("Explore"))
    .map((span) => attr(span as never, "bb.turn.index"));
export const turnIndexes = (spans: Array<{ name: string }>) =>
  spans
    .filter((span) => span.name.startsWith("invoke_agent"))
    .map((span) => attr(span as never, "bb.turn.index"));
/** The spans in the OTLP JSON that `bb sentry-traces export` prints. */
export function exportedSpans(stdout: string) {
  // A narrow cast at this boundary: the parts of the export these tests read.
  const body = JSON.parse(stdout) as {
    resourceSpans: Array<{
      scopeSpans: Array<{ spans: Array<{ name: string; attributes: Array<{ key: string }> }> }>;
    }>;
  };
  return must(must(body.resourceSpans[0], "resource spans").scopeSpans[0], "scope spans").spans;
}
/** A finished turn of `items` commands. */
export function turnOf(h: History, turnId: string, items: number) {
  h.request(`${turnId}-req`).start(turnId, `${turnId}-req`);
  for (let index = 0; index < items; index++) {
    h.item(turnId, { type: "commandExecution", id: `${turnId}-${index}`, command: "ls" }, 1);
  }
  h.complete(turnId);
}

