/**
 * The Workflows integration. A workflow script runs outside any thread, so
 * the only trace of it is the worker threads it spawns. Two things tie those
 * back together, both read from the bundled Workflows plugin:
 *
 * - each worker thread's Workflows metadata, which names its run, its call
 *   and the thread that started the run (no secrets are kept there);
 * - the `workflowRunView` RPC, which gives the run's phases and calls.
 *
 * That RPC is internal to the Workflows plugin and can change. Any failed read
 * means "not a workflow worker" and the thread exports on its own.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { errorMessage, identifier, record, text } from "../../core/text.js";
import type { ThreadInfo } from "../../thread.js";
import type { WorkflowContext } from "./ids.js";
import { allCalls, callFacts, runViewResultSchema, type WorkflowRunView } from "./schema.js";

export const WORKFLOWS_PLUGIN_ID = "workflows";

/** How long to stop asking after Workflows failed to answer. */
const UNAVAILABLE_MS = 5 * 60 * 1_000;

export class WorkflowsClient {
  private unavailableUntil = 0;

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "log">,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The run, `null` when Workflows has no such run, or `undefined` when it did
   * not answer.
   */
  async runView(originThreadId: string, runId: string): Promise<WorkflowRunView | null | undefined> {
    if (this.unavailableUntil > this.now()) return undefined;
    try {
      const result = await this.bb.sdk.plugins.callRpc({
        pluginId: WORKFLOWS_PLUGIN_ID,
        method: "workflowRunView",
        input: { threadId: originThreadId, runId },
        outputSchema: runViewResultSchema,
      });
      // Parsed here too, so the schema's defaults hold whatever the transport does.
      return runViewResultSchema.parse(result).run;
    } catch (cause) {
      this.unavailableUntil = this.now() + UNAVAILABLE_MS;
      this.bb.log.debug(`Workflows workflowRunView is not available: ${errorMessage(cause)}`);
      return undefined;
    }
  }

  /** Where a worker thread sits in a workflow run, or null when it is not a worker. */
  async workerContext(thread: ThreadInfo): Promise<WorkflowContext | null> {
    if (thread.originPluginId !== WORKFLOWS_PLUGIN_ID) return null;
    let metadata: Record<string, unknown>;
    try {
      metadata = record(
        await this.bb.sdk.threads.getPluginMetadata({
          threadId: thread.id,
          pluginId: WORKFLOWS_PLUGIN_ID,
        }),
      );
    } catch (cause) {
      this.bb.log.debug(`Could not read Workflows metadata of ${thread.id}: ${errorMessage(cause)}`);
      return null;
    }
    // Any client can write thread metadata, so only well-formed values count.
    const runId = text(metadata['runId']);
    const callId = text(metadata['callId']);
    const originThreadId = text(metadata['originThreadId']) || thread.lifecycleOwnerThreadId || "";
    if (!runId || !callId || !originThreadId) return null;

    const run = await this.runView(originThreadId, runId);
    const call = run ? allCalls(run).find((candidate) => candidate.id === callId) : undefined;
    return {
      runId,
      callId,
      originThreadId,
      name: run ? identifier(run.name) : null,
      scriptName: run?.name ?? null,
      callIndex: call?.index ?? null,
      call: call ? callFacts(call) : null,
    };
  }
}
