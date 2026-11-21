/**
 * A provider's trace as OpenTelemetry spans: the trace's own ids, its root
 * when it names none, and the spans it sends, checked and attributed.
 */
import { span as otlpSpan, spanIdFor, traceIdFor, type AttributeValue, type OtlpSpan } from "../../core/otlp.js";
import { scrub } from "../../core/scrub/cut.js";
import { sanitizeAttributes, sanitizeContent, type ProviderSpan, type ProviderTrace } from "./schema.js";
import { ROOT_KEY, type TraceContext } from "./types.js";

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

/** The first span with each key: a repeated key would fork the tree, so only the first counts. */
function firstOfEachKey(trace: ProviderTrace): ProviderSpan[] {
  const seen = new Set<string>();
  return trace.spans.filter((span) => !seen.has(span.key) && Boolean(seen.add(span.key)));
}

/**
 * The keys of the spans to send now, leaving out those already sent. Before
 * the trace ends, only spans its provider says are final; never the root,
 * which covers the whole trace. Once it has ended, all the rest, and the root
 * even when the provider sent none, so one can be made.
 */
export function keysToSend(trace: ProviderTrace, sent: ReadonlySet<string>, ended: boolean): Set<string> {
  const keys = new Set<string>();
  for (const span of firstOfEachKey(trace)) {
    if (sent.has(span.key)) continue;
    if (ended || (span.final === true && span.key !== ROOT_KEY)) keys.add(span.key);
  }
  if (ended && !sent.has(ROOT_KEY)) keys.add(ROOT_KEY);
  return keys;
}

/**
 * A provider's trace as spans. Exactly one span is the root, with the key
 * `root`; a span whose parent is missing or unknown hangs under it.
 *
 * With `only`, just the spans with those keys, still linked to their parents
 * in the whole trace; the root is made when `only` has it and the trace has none.
 * `attributes` are added to the root.
 */
export function providerSpans(
  ref: TraceRef,
  trace: ProviderTrace,
  captureContent: boolean,
  options: { only?: ReadonlySet<string>; rootAttributes?: Record<string, AttributeValue> } = {},
): OtlpSpan[] {
  const { only, rootAttributes = {} } = options;
  const traceId = providerTraceId(ref.provider, ref.traceKey);
  const id = (spanKey: string) => providerSpanId(ref.provider, ref.traceKey, spanKey);
  const shared = traceAttributes({
    ...ref,
    pipeline: trace.pipeline || ref.pipeline,
    traceAttributes: { ...ref.traceAttributes, ...sanitizeAttributes(trace.attributes) },
  });
  const keys = new Set(trace.spans.map((span) => span.key));
  const spans: OtlpSpan[] = [];
  if (!keys.has(ROOT_KEY) && trace.spans.length > 0 && (!only || only.has(ROOT_KEY))) {
    // The contract asks for a root; without one, everything would hang in the air.
    spans.push(
      otlpSpan({
        traceId,
        spanId: id(ROOT_KEY),
        name: `${ref.provider}.trace ${trace.pipeline || ref.pipeline || ref.traceKey}`,
        start: Math.min(...trace.spans.map((span) => span.start)),
        end: Math.max(...trace.spans.map((span) => span.end)),
        attributes: { ...shared, ...rootAttributes, "sentry.op": `${ref.provider}.trace`, "bb.inferred": true },
      }),
    );
  }
  for (const span of firstOfEachKey(trace)) {
    if (only && !only.has(span.key)) continue;
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
          ...(isRoot ? rootAttributes : {}),
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
