/**
 * Asks each provider named in the `providers` setting about the threads this
 * plugin is exporting. A provider that did not answer is remembered for a
 * while, so a slow or missing one does not hold up every export.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { errorMessage } from "../../core/text.js";
import { contextResultSchema, sanitizeAttributes, traceResultSchema, type ProviderTrace } from "./schema.js";
import { CONTRACT_VERSION, ROOT_KEY, type ThreadQuery, type TraceContext } from "./types.js";

const MAX_PROVIDERS = 8;

/**
 * How long to stop asking a provider after it failed to answer, or to stop
 * asking one question after its answer could not be read.
 */
export const UNAVAILABLE_MS = 5 * 60 * 1_000;
/** At most this many unreadable questions are remembered per provider. */
const MAX_UNREADABLE = 200;
/**
 * How long a provider that answered before may fail before it is taken to be
 * gone. Until then, which trace its threads belong to is unknown.
 */
const OUTAGE_GRACE_MS = 30 * 60 * 1_000;

/** Plugin ids from the `providers` setting: separated by commas or spaces. */
export function parseProviders(raw: string, self: string): string[] {
  const ids = raw
    .split(/[\s,]+/)
    .map((id) => id.trim())
    .filter((id) => /^[a-z0-9][a-z0-9-]*$/.test(id) && id !== self);
  return [...new Set(ids)].slice(0, MAX_PROVIDERS);
}

interface Availability {
  unavailableUntil: number;
  available: boolean | null;
  error: string | null;
  /** Whether it has ever given an answer this plugin could read, since this plugin loaded. */
  answered: boolean;
  /**
   * Questions it answered with something unreadable, and until when each is
   * not asked again. Its other questions are still asked.
   */
  unreadable: Map<string, number>;
  /** When its current run of failures began; null while it answers. */
  failingSince: number | null;
}

export class TraceProviders {
  private readonly state = new Map<string, Availability>();

  constructor(
    private readonly bb: Pick<BbPluginApi, "sdk" | "log">,
    private readonly providerIds: () => Promise<string[]>,
    private readonly now: () => number = Date.now,
  ) {}

  /** How each provider's last call went, for `status`. */
  async status(): Promise<Array<{ provider: string; available: boolean | null; error: string | null }>> {
    return (await this.providerIds()).map((provider) => ({
      provider,
      available: this.state.get(provider)?.available ?? null,
      error: this.state.get(provider)?.error ?? null,
    }));
  }

  private async call<T>(provider: string, method: string, input: Record<string, unknown>, schema: z.ZodType<T>) {
    const state = this.state.get(provider) ?? {
      unavailableUntil: 0,
      available: null,
      error: null,
      answered: false,
      failingSince: null,
      unreadable: new Map<string, number>(),
    };
    this.state.set(provider, state);
    const now = this.now();
    if (state.unavailableUntil > now) return undefined;
    const question = `${method} ${JSON.stringify(input)}`;
    for (const [asked, until] of state.unreadable) if (until <= now) state.unreadable.delete(asked);
    if (state.unreadable.has(question)) return undefined;
    const unavailable = (message: string, reason: "unreached" | "other-contract" | "unreadable") => {
      // Missing, disabled, older than the contract, or answering nonsense: not an error for us.
      // The time is read now: the call may have taken long to fail.
      const failedAt = this.now();
      if (reason === "unreached") {
        state.unavailableUntil = failedAt + UNAVAILABLE_MS;
        state.failingSince ??= failedAt;
      } else {
        // It is there and said nothing this plugin can use: an answer, not an outage.
        state.failingSince = null;
        if (reason === "other-contract") {
          // Every answer of its will be like this one.
          state.unavailableUntil = failedAt + UNAVAILABLE_MS;
        } else {
          // Only this question waits; a trace too large to read must not stop
          // its threads from being placed.
          if (state.unreadable.size >= MAX_UNREADABLE) {
            const [oldest] = state.unreadable.keys();
            if (oldest !== undefined) state.unreadable.delete(oldest);
          }
          state.unreadable.set(question, failedAt + UNAVAILABLE_MS);
        }
      }
      const text = message.slice(0, 300);
      if (text !== state.error) {
        this.bb.log.debug(`Trace provider ${provider} did not answer ${method}: ${text}`);
      }
      state.available = false;
      state.error = text;
      return undefined;
    };
    let output: unknown;
    try {
      // The answer is checked here rather than by the transport, so a call that
      // failed can be told apart from an answer that does not fit the contract.
      output = await this.bb.sdk.plugins.callRpc({
        pluginId: provider,
        method,
        input: { contract: CONTRACT_VERSION, ...input },
        outputSchema: z.unknown(),
      });
    } catch (cause) {
      return unavailable(errorMessage(cause), "unreached");
    }
    const parsed = schema.safeParse(output);
    if (!parsed.success) {
      // Only an answer that names another version is one: an answer with no
      // version at all is a broken answer to this one question.
      const contract = (output as { contract?: unknown } | null | undefined)?.contract;
      return contract === undefined || contract === null || contract === CONTRACT_VERSION
        ? unavailable(`unreadable answer: ${parsed.error.message}`, "unreadable")
        : unavailable(`answered with contract ${JSON.stringify(contract)}`, "other-contract");
    }
    state.available = true;
    state.error = null;
    state.answered = true;
    state.failingSince = null;
    return parsed.data;
  }

  /**
   * Whether a provider that did not answer may still be there: it answered
   * before and has not been failing for long. Its answer is then unknown, not no.
   */
  private outage(provider: string): boolean {
    const state = this.state.get(provider);
    if (!state?.answered || state.failingSince === null) return false;
    return this.now() - state.failingSince < OUTAGE_GRACE_MS;
  }

  /** One provider's answers for several threads; a thread it does not know is absent. */
  async contexts(provider: string, threads: readonly ThreadQuery[]): Promise<Map<string, TraceContext>> {
    return (await this.lookup(provider, threads)) ?? new Map();
  }

  /** Like `contexts`, but `undefined` when the provider did not answer. */
  private async lookup(
    provider: string,
    threads: readonly ThreadQuery[],
  ): Promise<Map<string, TraceContext> | undefined> {
    const found = new Map<string, TraceContext>();
    if (threads.length === 0) return found;
    const result = await this.call(
      provider,
      "telemetry_thread_context",
      { threads: threads.slice(0, 200) },
      contextResultSchema,
    );
    if (result === undefined) return undefined;
    for (const { threadId } of threads) {
      const context = result?.contexts[threadId];
      if (!context) continue;
      found.set(threadId, {
        provider,
        traceKey: context.trace.key,
        endedAt: context.trace.endedAt ?? null,
        parentKey: context.parent || ROOT_KEY,
        agentId: context.agent?.id || null,
        agentName: context.agent?.name || null,
        model: context.model || null,
        pipeline: context.trace.pipeline || null,
        traceAttributes: sanitizeAttributes(context.trace.attributes),
        attributes: sanitizeAttributes(context.attributes),
      });
    }
    return found;
  }

  /**
   * Where a thread sits in a provider's trace, or null when no provider claims
   * it. The first provider with an answer wins. `undefined` when a provider
   * that may still claim it did not answer: placing the thread now would be
   * for good, so the caller should ask again later.
   *
   * A workflow worker a provider cannot place takes its trace from the thread
   * that started its workflow, when that thread is in a trace: its turns then
   * hang under its workflow call, and it gets no agent from the provider.
   */
  async threadContext(thread: ThreadQuery): Promise<TraceContext | null | undefined> {
    const originThreadId = thread.workflow?.originThreadId;
    const threads = originThreadId ? [thread, { threadId: originThreadId }] : [thread];
    for (const provider of await this.providerIds()) {
      const contexts = await this.lookup(provider, threads);
      if (contexts === undefined) {
        // An earlier provider's answer would win over any later one's.
        if (this.outage(provider)) return undefined;
        continue;
      }
      const own = contexts.get(thread.threadId);
      if (own) return own;
      const origin = originThreadId ? contexts.get(originThreadId) : undefined;
      if (origin) {
        return { ...origin, agentId: null, agentName: null, model: null, attributes: {} };
      }
    }
    return null;
  }

  /**
   * A trace's own spans, `null` when the provider says it has no such trace,
   * or `undefined` when it did not answer.
   */
  async trace(
    provider: string,
    traceKey: string,
    includeContent: boolean,
  ): Promise<ProviderTrace | null | undefined> {
    const result = await this.call(provider, "telemetry_trace", { traceKey, includeContent }, traceResultSchema);
    return result ? result.trace : undefined;
  }
}

