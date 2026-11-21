/**
 * Trace providers. Any bb plugin can say "these threads belong to one trace of
 * mine, and here is that trace's own structure" by answering two RPC methods,
 * described in docs/trace-provider-contract.md:
 *
 * - `telemetry_thread_context`: which trace a thread belongs to, where its
 *   turns hang, and which agent it runs as;
 * - `telemetry_trace`: the trace's own spans.
 *
 * This plugin knows nothing about what a provider's trace means. It asks the
 * plugins named in the `providers` setting, checks and caps what comes back,
 * and never reads a provider's database or thread metadata.
 *
 * A provider may be missing, disabled, or older than the contract. A provider
 * that has never answered is taken to be absent, and the thread exports on its
 * own. One that answered before and stopped is asked again for a while before
 * it is taken to be gone, so a reload does not move threads out of its traces.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { span as otlpSpan, spanIdFor, traceIdFor, type AttributeValue, type OtlpSpan } from "./otlp.js";
import { scrub } from "./scrub.js";
import { errorMessage } from "./util.js";

export const CONTRACT_VERSION = 1;
/** The key of a trace's root span, and where a thread hangs when a provider names no parent. */
export const ROOT_KEY = "root";

const MAX_PROVIDERS = 8;
const MAX_SPANS = 2_000;
const MAX_ATTRIBUTES = 64;
const MAX_ATTRIBUTE_CHARS = 2_000;
const MAX_CONTENT_CHARS = 8_000;
const MAX_KEY_CHARS = 200;
/** How long to stop asking a provider after it failed to answer. */
export const UNAVAILABLE_MS = 5 * 60 * 1_000;
/**
 * How long a provider that answered before may fail before it is taken to be
 * gone. Until then, which trace its threads belong to is unknown.
 */
const OUTAGE_GRACE_MS = 30 * 60 * 1_000;

/** What Workflows says about a worker thread, sent along so a provider can place and name it. */
export interface WorkflowHint {
  runId: string;
  /** The workflow's name as its script declares it. */
  name: string | null;
  callId: string;
  callIndex: number | null;
  originThreadId: string;
  phase: string | null;
  provider: string | null;
  model: string | null;
  reasoningLevel: string | null;
}

export interface ThreadQuery {
  threadId: string;
  workflow?: WorkflowHint | null;
}

/** Where a thread sits in a provider's trace. */
export interface TraceContext {
  /** The plugin that answered. */
  provider: string;
  traceKey: string;
  /** When the trace ended; null while it can still grow. */
  endedAt: number | null;
  /** The span of the trace the thread's turns hang under. */
  parentKey: string;
  agentId: string | null;
  agentName: string | null;
  /** The model to report when bb recorded none for a turn. */
  model: string | null;
  pipeline: string | null;
  /** On every span of the trace. */
  traceAttributes: Record<string, AttributeValue>;
  /** On this thread's spans only. */
  attributes: Record<string, AttributeValue>;
}

const key = z.string().min(1).max(MAX_KEY_CHARS);
const optionalText = z.string().nullish();
const attributeMap = z.record(z.string(), z.unknown()).nullish();

const contextSchema = z
  .object({
    trace: z
      .object({
        key,
        endedAt: z.number().nullish(),
        pipeline: optionalText,
        attributes: attributeMap,
      })
      .loose(),
    parent: key.nullish(),
    agent: z.object({ id: optionalText, name: optionalText }).loose().nullish(),
    model: optionalText,
    attributes: attributeMap,
  })
  .loose();

const contextResultSchema = z
  .object({
    contract: z.literal(CONTRACT_VERSION),
    contexts: z.record(z.string(), contextSchema.nullable()),
  })
  .loose();

const spanSchema = z
  .object({
    key,
    parentKey: key.nullish(),
    name: z.string().min(1),
    op: optionalText,
    start: z.number(),
    end: z.number(),
    status: z.enum(["ok", "error"]).nullish(),
    errorType: optionalText,
    errorMessage: optionalText,
    kind: z.enum(["internal", "client"]).nullish(),
    attributes: attributeMap,
    content: attributeMap,
    workflowRunId: optionalText,
    workflowName: optionalText,
  })
  .loose();

const traceResultSchema = z
  .object({
    contract: z.literal(CONTRACT_VERSION),
    trace: z
      .object({
        key,
        ended: z.boolean(),
        pipeline: optionalText,
        attributes: attributeMap,
        spans: z.array(spanSchema).max(MAX_SPANS),
      })
      .loose()
      .nullable(),
  })
  .loose();

export type ProviderTrace = NonNullable<z.infer<typeof traceResultSchema>["trace"]>;
export type ProviderSpan = z.infer<typeof spanSchema>;

/** Attribute keys a provider may not set: they are this plugin's or Sentry's to set. */
const RESERVED_KEY = /^(sentry\.|bb\.thread\.|bb\.turn\.|bb\.trace\.)|^gen_ai\.conversation\.id$/;
const ATTRIBUTE_KEY = /^[A-Za-z][\w.-]{0,99}$/;

/**
 * A provider's attributes, as they may be sent: plain keys, scalar values,
 * bounded in number and size. Anything else is dropped, not repaired.
 */
export function sanitizeAttributes(
  values: Record<string, unknown> | null | undefined,
): Record<string, AttributeValue> {
  const kept: Record<string, AttributeValue> = {};
  let count = 0;
  for (const [name, value] of Object.entries(values ?? {})) {
    if (count >= MAX_ATTRIBUTES) break;
    if (!ATTRIBUTE_KEY.test(name) || RESERVED_KEY.test(name)) continue;
    if (typeof value === "string") kept[name] = value.slice(0, MAX_ATTRIBUTE_CHARS);
    else if (typeof value === "boolean") kept[name] = value;
    else if (typeof value === "number" && Number.isFinite(value)) kept[name] = value;
    else continue;
    count++;
  }
  return kept;
}

/** A provider's content attributes: text only, scrubbed and capped. */
function sanitizeContent(values: Record<string, unknown> | null | undefined) {
  const kept: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(sanitizeAttributes(values))) {
    if (typeof value === "string") kept[name] = scrub(value, MAX_CONTENT_CHARS);
  }
  return kept;
}

export function providerTraceId(provider: string, traceKey: string): string {
  return traceIdFor(`provider/${provider}/${traceKey}`);
}
export function providerSpanId(provider: string, traceKey: string, spanKey: string): string {
  return spanIdFor(`provider/${provider}/${traceKey}/${spanKey}`);
}

/** The attributes every span of a provider's trace carries. */
export function traceAttributes(context: {
  provider: string;
  traceKey: string;
  pipeline: string | null;
  traceAttributes: Record<string, AttributeValue>;
}): Record<string, AttributeValue> {
  return {
    ...context.traceAttributes,
    "bb.trace.provider": context.provider,
    "bb.trace.key": context.traceKey,
    // Left out entirely when unknown, so it cannot blank another source's value.
    ...(context.pipeline ? { "gen_ai.pipeline.name": context.pipeline } : {}),
  };
}

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
  /** Whether it has ever answered, since this plugin loaded. */
  answered: boolean;
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
    };
    this.state.set(provider, state);
    if (state.unavailableUntil > this.now()) return undefined;
    const unavailable = (message: string, reached: boolean) => {
      // Missing, disabled, older than the contract, or answering nonsense: not an error for us.
      state.unavailableUntil = this.now() + UNAVAILABLE_MS;
      if (reached) {
        // It is there and said nothing this plugin can use: that is an answer, not an outage.
        state.answered = true;
        state.failingSince = null;
      } else {
        state.failingSince ??= this.now();
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
        input: { contract: CONTRACT_VERSION, ...input } as never,
        outputSchema: z.unknown(),
      });
    } catch (cause) {
      return unavailable(errorMessage(cause), false);
    }
    const parsed = schema.safeParse(output);
    if (!parsed.success) return unavailable(`unreadable answer: ${parsed.error.message}`, true);
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

/**
 * The context a turn belongs to. A thread stays tied to its trace after the
 * trace has ended (a coordinator thread can be chatted in for days), so a turn
 * that started after the end is the thread's own and gets its own trace.
 */
export function contextForTurn(
  turn: { start: number },
  context: TraceContext | null,
): TraceContext | null {
  if (!context || context.endedAt === null) return context;
  return turn.start >= context.endedAt ? null : context;
}

/** A bb Workflows run, as a provider's span can name it: by run id or by script name. */
export interface WorkflowRef {
  runId: string;
  name: string | null;
}

/** The span of a trace that says it started the workflow run, if any. */
export function workflowSpan(
  trace: ProviderTrace | null | undefined,
  workflow: WorkflowRef,
): ProviderSpan | undefined {
  return trace?.spans.find(
    (span) =>
      span.workflowRunId === workflow.runId ||
      (workflow.name !== null && span.workflowName === workflow.name),
  );
}

type TraceRef = Pick<TraceContext, "provider" | "traceKey" | "pipeline" | "traceAttributes">;

/**
 * A root for a trace its provider no longer has, so the thread turns already
 * sent into it are not left without one.
 */
export function deletedTraceSpans(ref: TraceRef, seen: { from: number; to: number }): OtlpSpan[] {
  return [
    otlpSpan({
      traceId: providerTraceId(ref.provider, ref.traceKey),
      spanId: providerSpanId(ref.provider, ref.traceKey, ROOT_KEY),
      name: `${ref.provider}.trace ${ref.pipeline ?? ref.traceKey}`,
      start: seen.from,
      end: Math.max(seen.from, seen.to),
      attributes: {
        ...traceAttributes(ref),
        "sentry.op": `${ref.provider}.trace`,
        "bb.trace.state": "deleted",
        // The trace's real times went with it; these are when this plugin saw it.
        "bb.inferred": true,
      },
    }),
  ];
}

/**
 * A provider's trace as spans. Exactly one span is the root, with the key
 * `root`; a span whose parent is missing or unknown hangs under it.
 */
export function providerSpans(ref: TraceRef, trace: ProviderTrace, captureContent: boolean): OtlpSpan[] {
  const traceId = providerTraceId(ref.provider, ref.traceKey);
  const id = (spanKey: string) => providerSpanId(ref.provider, ref.traceKey, spanKey);
  const shared = traceAttributes({
    ...ref,
    pipeline: trace.pipeline || ref.pipeline,
    traceAttributes: { ...ref.traceAttributes, ...sanitizeAttributes(trace.attributes) },
  });
  const keys = new Set(trace.spans.map((span) => span.key));
  const spans: OtlpSpan[] = [];
  if (!keys.has(ROOT_KEY) && trace.spans.length > 0) {
    // The contract asks for a root; without one, everything would hang in the air.
    spans.push(
      otlpSpan({
        traceId,
        spanId: id(ROOT_KEY),
        name: `${ref.provider}.trace ${trace.pipeline || ref.pipeline || ref.traceKey}`,
        start: Math.min(...trace.spans.map((span) => span.start)),
        end: Math.max(...trace.spans.map((span) => span.end)),
        attributes: { ...shared, "sentry.op": `${ref.provider}.trace`, "bb.inferred": true },
      }),
    );
  }
  const sent = new Set<string>();
  for (const span of trace.spans) {
    // The first span with a key wins; a repeated key would fork the tree.
    if (sent.has(span.key)) continue;
    sent.add(span.key);
    const isRoot = span.key === ROOT_KEY;
    const parentKey = span.parentKey && keys.has(span.parentKey) ? span.parentKey : ROOT_KEY;
    const failed = span.status === "error";
    spans.push(
      otlpSpan({
        traceId,
        spanId: id(span.key),
        parentSpanId: isRoot ? null : id(parentKey),
        name: span.name,
        client: span.kind === "client",
        start: span.start,
        end: span.end,
        attributes: {
          ...sanitizeAttributes(span.attributes),
          ...(captureContent ? sanitizeContent(span.content) : {}),
          ...shared,
          "sentry.op": span.op || `${ref.provider}.span`,
          "bb.workflow.run_id": span.workflowRunId || undefined,
          "error.type": failed ? span.errorType || "error" : undefined,
        },
        error: failed
          ? {
              // Free text from the provider is content.
              message:
                captureContent && span.errorMessage
                  ? scrub(span.errorMessage, 300)
                  : span.errorType || "error",
            }
          : null,
      }),
    );
  }
  return spans;
}
