/**
 * The wire format of the trace provider contract: what a provider may send
 * back, and how its attributes and content are checked and capped before they
 * become span attributes. Anything that does not fit is dropped, not repaired.
 */
import { z } from "zod";
import { scrubText } from "../../core/scrub/value.js";
import { MAX_TIME_MS, type AttributeValue } from "../../core/otlp.js";
import { head } from "../../core/text.js";
import { CONTRACT_VERSION } from "./types.js";

const MAX_SPANS = 2_000;
const MAX_ATTRIBUTES = 64;
const MAX_ATTRIBUTE_CHARS = 2_000;
const MAX_CONTENT_CHARS = 8_000;
const MAX_KEY_CHARS = 200;

const key = z.string().min(1).max(MAX_KEY_CHARS);
const optionalText = z.string().nullish();
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
    start: time,
    end: time,
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
  /^(?:gen_ai\.(?:input\.|output\.|tool\.call\.|prompt|completion|system_instructions$|request\.messages$)|bb\.environment\.branch$|bb\.span\.detail$)/i;
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

/**
 * A provider's content attributes: text only, scrubbed whole and only then
 * capped, so a cut cannot leave the head of a secret that no longer looks
 * like one.
 */
export function sanitizeContent(values: Record<string, unknown> | null | undefined) {
  const kept: Record<string, AttributeValue> = {};
  for (const [name, value] of Object.entries(keep(values, () => false, Number.POSITIVE_INFINITY))) {
    if (typeof value === "string") kept[name] = scrubText(value, MAX_CONTENT_CHARS);
  }
  return kept;
}

