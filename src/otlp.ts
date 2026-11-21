/**
 * The OTLP/JSON trace encoding, and ids derived from stable keys so the same
 * turn always produces the same trace and span ids, across restarts too.
 */
import { createHash } from "node:crypto";

export type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

export interface Attribute {
  key: string;
  value: AnyValue;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: number; message?: string };
}

export interface OtlpTraces {
  resourceSpans: Array<{
    resource: { attributes: Attribute[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[] }>;
  }>;
}

export const SPAN_KIND_INTERNAL = 1;
export const SPAN_KIND_CLIENT = 3;
export const STATUS_UNSET = 0;
export const STATUS_OK = 1;
export const STATUS_ERROR = 2;

/** Sentry stores long attribute values, but one runaway value should not sink a request. */
export const MAX_ATTRIBUTE_CHARS = 32_000;

export type AttributeValue = string | number | boolean | null | undefined;

/** A stable, never-all-zero hex id: 16 bytes for traces, 8 for spans. */
export function hexId(input: string, bytes: 8 | 16): string {
  const id = createHash("sha256")
    .update(input)
    .digest("hex")
    .slice(0, bytes * 2);
  return /^0+$/.test(id) ? `${id.slice(0, -1)}1` : id;
}

export function traceIdFor(key: string): string {
  return hexId(`trace:${key}`, 16);
}

export function spanIdFor(key: string): string {
  return hexId(`span:${key}`, 8);
}

/** Milliseconds since the epoch as OTLP's nanosecond string. */
export function nanos(ms: number): string {
  return `${Math.max(0, Math.round(ms))}000000`;
}

/** Drops empty values; whole numbers become ints, the rest doubles. */
export function attributes(values: Record<string, AttributeValue>): Attribute[] {
  return Object.entries(values).flatMap(([key, value]): Attribute[] => {
    if (value === null || value === undefined || value === "") return [];
    if (typeof value === "boolean") return [{ key, value: { boolValue: value } }];
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return [];
      return Number.isInteger(value)
        ? [{ key, value: { intValue: String(value) } }]
        : [{ key, value: { doubleValue: value } }];
    }
    return [{ key, value: { stringValue: value.slice(0, MAX_ATTRIBUTE_CHARS) } }];
  });
}

export interface SpanInput {
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  /** Model requests are client spans; agent runs and tool calls are internal. */
  client?: boolean;
  start: number;
  end: number;
  attributes: Record<string, AttributeValue>;
  /** Set for a failed span; the message is optional. */
  error?: { message?: string | null } | null;
}

/** The operations Sentry was seen to describe on its own. */
const SELF_DESCRIBED = new Set(["invoke_agent", "chat", "execute_tool"]);

export function span(input: SpanInput): OtlpSpan {
  const start = Math.round(input.start);
  const name = input.name.slice(0, 200);
  // Sentry derives a description for agent, model and tool spans only; any
  // other span shows "(no description)" unless it is given one.
  const operation = input.attributes["gen_ai.operation.name"];
  const described =
    (typeof operation === "string" && SELF_DESCRIBED.has(operation)) ||
    input.attributes["sentry.description"]
      ? input.attributes
      : { ...input.attributes, "sentry.description": name };
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    ...(input.parentSpanId ? { parentSpanId: input.parentSpanId } : {}),
    name,
    kind: input.client ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(Math.max(start, input.end)),
    attributes: attributes(described),
    status: input.error
      ? {
          code: STATUS_ERROR,
          ...(input.error.message ? { message: input.error.message.slice(0, 500) } : {}),
        }
      : { code: STATUS_OK },
  };
}

export interface ResourceInfo {
  pluginVersion: string;
  bbVersion?: string | null;
  environment?: string | null;
}

export const SCOPE_NAME = "bb-plugin-sentry-traces";

/** One OTLP/JSON request body holding `spans`. */
export function envelope(spans: OtlpSpan[], resource: ResourceInfo): OtlpTraces {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributes({
            "service.name": "bb",
            "service.version": resource.bbVersion,
            "deployment.environment.name": resource.environment,
            "deployment.environment": resource.environment,
            "sentry.environment": resource.environment,
          }),
        },
        scopeSpans: [{ scope: { name: SCOPE_NAME, version: resource.pluginVersion }, spans }],
      },
    ],
  };
}

export function spansOf(payload: OtlpTraces): OtlpSpan[] {
  return payload.resourceSpans.flatMap((resource) =>
    resource.scopeSpans.flatMap((scope) => scope.spans),
  );
}
