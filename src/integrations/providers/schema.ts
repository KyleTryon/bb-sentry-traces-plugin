/**
 * The wire format of the trace provider contract: what a provider may send
 * back, and how its attributes and content are checked and capped before they
 * become span attributes. Anything that does not fit is dropped, not repaired.
 */
import { z } from "zod";
import { scrubText } from "../../core/scrub/value.js";
import type { AttributeValue } from "../../core/otlp.js";
import { CONTRACT_VERSION } from "./types.js";

const MAX_SPANS = 2_000;
const MAX_ATTRIBUTES = 64;
const MAX_ATTRIBUTE_CHARS = 2_000;
const MAX_CONTENT_CHARS = 8_000;
const MAX_KEY_CHARS = 200;

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

export const contextResultSchema = z
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
    final: z.boolean().nullish(),
  })
  .loose();

export const traceResultSchema = z
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
export function sanitizeContent(values: Record<string, unknown> | null | undefined) {
  const kept: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(sanitizeAttributes(values))) {
    if (typeof value === "string") kept[name] = scrubText(value, MAX_CONTENT_CHARS);
  }
  return kept;
}

