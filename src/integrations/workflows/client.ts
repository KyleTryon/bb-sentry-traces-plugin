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
 * may disable or remove Workflows. When Workflows is not there to ask, or
 * answers in a shape this plugin does not know, a thread is "not a workflow
 * worker": it exports on its own at once and nothing waits for Workflows.
 * When Workflows fails for a moment, a worker's export waits for it, for
 * `FAILING_WAIT_MS` at most: placed now, the worker would be outside its run
 * for good. A failure is logged once until Workflows answers again.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { errorMessage, identifier, record, text } from "../../core/text.js";
import type { ThreadInfo } from "../../thread.js";
import type { WorkflowContext } from "./ids.js";
import { allCalls, runViewResultSchema, type WorkflowRunView } from "./schema.js";

const WORKFLOWS_PLUGIN_ID = "workflows";

/** How long to stop asking after Workflows said it is not there. */
const UNAVAILABLE_MS = 5 * 60 * 1_000;
/** How long a worker's export waits while Workflows keeps failing, before it goes out on its own. */
const FAILING_WAIT_MS = 30 * 60 * 1_000;

/** What `workerContext` gives while Workflows fails for a moment: ask again shortly. */
export const NOT_NOW = "not-now";

/** A field of a thrown value, which may be anything. */
function fieldOf(cause: unknown, name: string): unknown {
  return typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>)[name] : undefined;
}

/**
 * Whether a failed call says Workflows is not there to ask, rather than that
 * it failed this once. bb answers 404 for a plugin that is not installed and
 * for a method it lacks (`unknown_method`), and 503 for one that is not
 * running, with its status: only `disabled` lasts. A refusal (`not_found`,
 * `forbidden`) or an answer of an unknown shape would come again too.
 */
function absent(cause: unknown): boolean {
  if (cause instanceof z.ZodError || fieldOf(cause, "name") === "ZodError") return true;
  const code = fieldOf(cause, "code");
  if (code === "unknown_method" || code === "not_found" || code === "forbidden") return true;
  if (fieldOf(cause, "status") === 404) return true;
  return /status: disabled/.test(errorMessage(cause));
}

export class WorkflowsClient {
  private unavailableUntil = 0;
  /** When Workflows started failing, while it fails for what may be a moment. */
  private failingSince: number | null = null;
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
      this.failingSince = null;
      return run;
    } catch (cause) {
      if (absent(cause)) {
        this.unavailableUntil = this.now() + UNAVAILABLE_MS;
        this.failingSince = null;
      } else {
        this.failingSince ??= this.now();
      }
      this.logOnce(`Workflows workflowRunView is not available: ${errorMessage(cause)}`);
      return undefined;
    }
  }

  /** Whether Workflows is failing, but not for long enough to give up on it. */
  private failingBriefly(): boolean {
    return this.failingSince !== null && this.now() - this.failingSince < FAILING_WAIT_MS;
  }

  private logOnce(message: string): void {
    if (this.failing) return;
    this.failing = true;
    this.bb.log.debug(message);
  }

  /**
   * Where a worker thread sits in a workflow run, null when it is not a
   * worker, or `NOT_NOW` while Workflows fails for a moment.
   */
  async workerContext(thread: ThreadInfo): Promise<WorkflowContext | null | typeof NOT_NOW> {
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
    // Workflows is disabled, removed or has failed for too long: nothing
    // would ever send the run's own spans, so the worker's turns go out as its own.
    if (run === undefined) return this.failingBriefly() ? NOT_NOW : null;
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
