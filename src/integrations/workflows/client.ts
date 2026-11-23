/**
 * The Workflows integration. A workflow script runs outside any thread, so
 * the only trace of it is the worker threads it spawns. Two things tie those
 * back together, both read from the bundled Workflows plugin:
 *
 * - each worker thread's Workflows metadata, which names its run, its call
 *   and the thread that started the run (no secrets are kept there);
 * - the `workflowRunView` RPC, which gives the run's phases and calls.
 *
 * That RPC is internal to the Workflows plugin and can change, and the user
 * may disable or remove Workflows. Any failed read means "not a workflow
 * worker": the thread exports on its own at once, nothing waits for
 * Workflows, and a failure is logged once until Workflows answers again.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { errorMessage, identifier, record, text } from "../../core/text.js";
import type { ThreadInfo } from "../../thread.js";
import type { WorkflowContext } from "./ids.js";
import { allCalls, runViewResultSchema, type WorkflowRunView } from "./schema.js";

export const WORKFLOWS_PLUGIN_ID = "workflows";

/** How long to stop asking after Workflows failed to answer. */
const UNAVAILABLE_MS = 5 * 60 * 1_000;

export class WorkflowsClient {
  private unavailableUntil = 0;
  /** Whether a failure was logged since Workflows last answered, so it is logged once. */
  private failing = false;

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
      const run = runViewResultSchema.parse(result).run;
      this.failing = false;
      return run;
    } catch (cause) {
      this.unavailableUntil = this.now() + UNAVAILABLE_MS;
      this.logOnce(`Workflows workflowRunView is not available: ${errorMessage(cause)}`);
      return undefined;
    }
  }

  private logOnce(message: string): void {
    if (this.failing) return;
    this.failing = true;
    this.bb.log.debug(message);
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
      this.logOnce(`Could not read Workflows metadata of ${thread.id}: ${errorMessage(cause)}`);
      return null;
    }
    // Any client can write thread metadata, so only well-formed values count.
    const runId = text(metadata['runId']);
    const callId = text(metadata['callId']);
    const originThreadId = text(metadata['originThreadId']) || thread.lifecycleOwnerThreadId || "";
    if (!runId || !callId || !originThreadId) return null;

    const run = await this.runView(originThreadId, runId);
    // Workflows is disabled, removed or not answering: nothing would ever send
    // the run's own spans, so the worker's turns go out as its own.
    if (run === undefined) return null;
    const call = run ? allCalls(run).find((candidate) => candidate.id === callId) : undefined;
    return {
      runId,
      callId,
      originThreadId,
      name: run ? identifier(run.name) : null,
      callIndex: call?.index ?? null,
    };
  }
}
