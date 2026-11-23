/**
 * The wire format of the trace provider contract: what a provider may report,
 * and how its attributes and content are checked and capped before they are
 * stored or become span attributes. Anything that does not fit is dropped, not
 * repaired.
 */
import { z } from "zod";
import { scrub } from "../../core/scrub/cut.js";
import { scrubText } from "../../core/scrub/value.js";
import { MAX_TIME_MS, type AttributeValue } from "../../core/otlp.js";
import { head } from "../../core/text.js";
import { ROOT_KEY, type TraceContext } from "./types.js";

const MAX_SPANS = 2_000;
/** Threads one `report_threads` call may report. */
const MAX_THREADS_PER_CALL = 200;
const MAX_ATTRIBUTES = 64;
const MAX_ATTRIBUTE_CHARS = 2_000;
const MAX_CONTENT_CHARS = 8_000;
/**
 * Bytes of content one span may carry, as stored; the values past it are
 * dropped. With it, a span with content fits in one stored value whenever the
 * same span without content does, so content capture never decides whether a
 * report is refused.
 */
const MAX_SPAN_CONTENT_BYTES = 48 * 1024;
/** A name, op, pipeline or other short text a provider may send. */
const MAX_TEXT_CHARS = 1_000;
/** Error text is sent cut to 300 characters; this much is kept until then. */
const MAX_ERROR_CHARS = 2_000;
const MAX_KEY_CHARS = 200;

const key = z.string().min(1).max(MAX_KEY_CHARS);
const optionalText = z.string().max(MAX_TEXT_CHARS).nullish();
/** Free text about an error: cut to `MAX_ERROR_CHARS` as it is stored, so any length is taken. */
const errorText = z.string().nullish();
const attributeMap = z.record(z.string(), z.unknown()).nullish();
/**
 * Milliseconds since the epoch. Anything past the year 2286 is not one, and
 * would not print as a plain number of nanoseconds.
 */
const time = z.number().min(0).max(MAX_TIME_MS);

const contextSchema = z
  .object({
    trace: z
      .object({
        key,
        endedAt: time.nullish(),
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

const spanSchema = z
  .object({
    key,
    parentKey: key.nullish(),
    name: z.string().min(1).max(MAX_TEXT_CHARS),
    op: optionalText,
    start: time,
    end: time,
    status: z.enum(["ok", "error"]).nullish(),
    errorType: optionalText,
    errorMessage: errorText,
    kind: z.enum(["internal", "client"]).nullish(),
    attributes: attributeMap,
    content: attributeMap,
    workflowRunId: optionalText,
    workflowName: optionalText,
    final: z.boolean().nullish(),
  })
  .loose();

export const traceSchema = z
  .object({
    key,
    ended: z.boolean(),
    pipeline: optionalText,
    attributes: attributeMap,
    spans: z.array(spanSchema).max(MAX_SPANS),
  })
  .loose();

/**
 * `contract` is any number here, so a call with another version reaches the
 * handler and gets an answer that names the version this plugin speaks.
 */
export const reportThreadsInput = z.object({
  contract: z.number(),
  threads: z
    .array(z.object({ threadId: key, context: contextSchema.nullable() }))
    .max(MAX_THREADS_PER_CALL),
});

export const reportThreadsOutput = z.object({
  contract: z.number(),
  sending: z.boolean(),
  results: z.record(z.string(), z.enum(["ok", "conflict", "invalid", "limit"])),
});

export const reportTraceInput = z
  .object({
    contract: z.number(),
    trace: traceSchema.optional(),
    deleted: z.object({ key }).optional(),
  })
  .refine((input) => (input.trace === undefined) !== (input.deleted === undefined), {
    message: "Send either `trace` or `deleted`, not both or neither.",
  });

export const reportTraceOutput = z.object({ contract: z.number(), sending: z.boolean() });

export type ThreadContextInput = z.infer<typeof contextSchema>;
export type ProviderTrace = z.infer<typeof traceSchema>;
export type ProviderSpan = z.infer<typeof spanSchema>;

/**
 * Attribute keys a provider may not set: they are this plugin's or Sentry's
 * to set. Checked without regard to case, so `SENTRY.op` cannot slip past.
 */
const RESERVED_KEY = /^(?:sentry\.|bb\.thread\.|bb\.turn\.|bb\.trace\.)|^gen_ai\.conversation\.id$/i;
/**
 * Keys that hold what a user or model wrote. They belong in `content`, which
 * is sent only with content capture; in `attributes` they would go out always.
 */
const CONTENT_KEY =
  /^(?:gen_ai\.(?:input\.|output\.|tool\.call\.|prompt|completion|system_instructions$|request\.messages$|request\.available_tools$|response\.text$|response\.tool_calls$|tool\.(?:input|output|description|definitions)$)|bb\.environment\.branch$|bb\.span\.detail$)/i;
/**
 * Keys that describe one model call: what it was, which model, what it used
 * and what it cost. A provider may set them on its own span for that call. On
 * a whole trace or thread they would land on every span, so Sentry would
 * count the tokens and cost once per span, the plugin's own chat spans too.
 */
const CALL_KEY = /^gen_ai\.(?:usage\.|cost\.|operation\.name$|request\.model$|response\.model$)/i;
const ATTRIBUTE_KEY = /^[A-Za-z][\w.-]{0,99}$/;

/** Plain keys and scalar values, bounded in number and size, leaving out keys `drop` names. */
function keep(
  values: Record<string, unknown> | null | undefined,
  drop: (name: string) => boolean,
  chars: number,
): Record<string, AttributeValue> {
  const kept: Record<string, AttributeValue> = {};
  let count = 0;
  for (const [name, value] of Object.entries(values ?? {})) {
    if (count >= MAX_ATTRIBUTES) break;
    if (!ATTRIBUTE_KEY.test(name) || RESERVED_KEY.test(name) || drop(name)) continue;
    if (typeof value === "string") kept[name] = head(value, chars);
    else if (typeof value === "boolean") kept[name] = value;
    else if (typeof value === "number" && Number.isFinite(value)) kept[name] = value;
    else continue;
    count++;
  }
  return kept;
}

/**
 * A provider's attributes for one of its own spans, as they may be sent:
 * plain keys, scalar values, bounded in number and size. Anything else is
 * dropped, not repaired, and so are keys for user or model text.
 */
export function sanitizeAttributes(
  values: Record<string, unknown> | null | undefined,
): Record<string, AttributeValue> {
  return keep(values, (name) => CONTENT_KEY.test(name), MAX_ATTRIBUTE_CHARS);
}

/**
 * A provider's attributes for a whole trace or thread. They land on every
 * span, this plugin's turns too, so keys that describe one model call are
 * dropped as well.
 */
export function sanitizeSharedAttributes(
  values: Record<string, unknown> | null | undefined,
): Record<string, AttributeValue> {
  return keep(values, (name) => CONTENT_KEY.test(name) || CALL_KEY.test(name), MAX_ATTRIBUTE_CHARS);
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/**
 * A provider's content attributes: text only, scrubbed whole and only then
 * capped, so a cut cannot leave the head of a secret that no longer looks
 * like one. Once the span carries `MAX_SPAN_CONTENT_BYTES`, the values after
 * are dropped; the span itself is kept.
 */
export function sanitizeContent(values: Record<string, unknown> | null | undefined) {
  const kept: Record<string, AttributeValue> = {};
  let size = 2;
  for (const [name, value] of Object.entries(keep(values, () => false, Number.POSITIVE_INFINITY))) {
    if (typeof value !== "string") continue;
    const text = scrubText(value, MAX_CONTENT_CHARS);
    size += bytes(name) + bytes(text) + 2;
    if (size > MAX_SPAN_CONTENT_BYTES) break;
    kept[name] = text;
  }
  return kept;
}

/**
 * A reported trace as it is stored until sent: attributes checked, and its
 * text kept only while content capture is on, already scrubbed. So what sits
 * in storage is no more than what may be sent.
 */
export function storedTrace(trace: ProviderTrace, captureContent: boolean): ProviderTrace {
  return {
    key: trace.key,
    ended: trace.ended,
    pipeline: trace.pipeline ?? null,
    attributes: sanitizeSharedAttributes(trace.attributes),
    spans: trace.spans.map((span) => ({
      key: span.key,
      parentKey: span.parentKey ?? null,
      name: span.name,
      op: span.op ?? null,
      start: span.start,
      end: span.end,
      status: span.status ?? null,
      errorType: span.errorType ?? null,
      errorMessage: captureContent && span.errorMessage ? scrub(span.errorMessage, MAX_ERROR_CHARS) : null,
      kind: span.kind ?? null,
      attributes: sanitizeAttributes(span.attributes),
      content: captureContent ? sanitizeContent(span.content) : null,
      workflowRunId: span.workflowRunId ?? null,
      workflowName: span.workflowName ?? null,
      final: span.final ?? null,
    })),
  };
}

/** A provider's claim of a thread, as the export reads it. */
export function claimContext(provider: string, context: ThreadContextInput): TraceContext {
  return {
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
  };
}
