/**
 * Sentry's direct OTLP traces endpoint, reached with plain `fetch`: the DSN
 * gives the ingest host, the project and the public key. No Sentry SDK.
 */
import { envelope, type OtlpSpan, type OtlpTraces, type ResourceInfo } from "./otlp.js";
import { errorMessage } from "./util.js";

export interface SentryTarget {
  /** `https://<ingest host>/api/<projectId>/integration/otlp/v1/traces` */
  endpoint: string;
  /** The value of the `x-sentry-auth` header. */
  authHeader: string;
  host: string;
  projectId: string;
}

export type DsnResult = { ok: true; target: SentryTarget } | { ok: false; reason: string };

/** Reads a DSN such as `https://<publicKey>@o1.ingest.us.sentry.io/42`. */
export function parseDsn(raw: string | undefined | null): DsnResult {
  const dsn = (raw ?? "").trim();
  if (!dsn) return { ok: false, reason: "No DSN is set." };
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return { ok: false, reason: "The DSN is not a URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "The DSN must start with https:// or http://." };
  }
  let publicKey: string;
  try {
    publicKey = decodeURIComponent(url.username);
  } catch {
    return { ok: false, reason: "The DSN's public key is not valid." };
  }
  if (!publicKey) return { ok: false, reason: "The DSN has no public key before the @." };
  const segments = url.pathname.split("/").filter(Boolean);
  const projectId = segments.pop() ?? "";
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    return { ok: false, reason: "The DSN does not end with a project id." };
  }
  // A self-hosted Sentry can live under a path prefix, which stays in front of /api.
  const prefix = segments.length > 0 ? `/${segments.join("/")}` : "";
  return {
    ok: true,
    target: {
      endpoint: `${url.protocol}//${url.host}${prefix}/api/${projectId}/integration/otlp/v1/traces`,
      authHeader: `sentry sentry_key=${publicKey}`,
      host: url.host,
      projectId,
    },
  };
}

export interface SendResult {
  ok: boolean;
  /** The HTTP status, or null when the request never got an answer. */
  status: number | null;
  message: string;
  /** Whether trying again later could work: not for a rejected key or payload. */
  retryable: boolean;
  /**
   * Sentry refused this payload, not the key or project: the same spans fail
   * again, but others can still go through.
   */
  payloadRejected: boolean;
  /** How many spans were accepted: always the first ones, in order. */
  spans: number;
}

export const SEND_TIMEOUT_MS = 10_000;
/** Spans per request, so one long turn cannot build an oversized body. */
export const MAX_SPANS_PER_REQUEST = 400;
/** Bytes of spans per request, since captured content can make a few spans large. */
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** Answers that refuse what was sent rather than who sent it. */
const PAYLOAD_REJECTED = new Set([400, 413, 422]);

export type Fetch = typeof fetch;

async function post(target: SentryTarget, payload: OtlpTraces, fetchImpl: Fetch) {
  try {
    const response = await fetchImpl(target.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sentry-auth": target.authHeader },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.ok) {
      return { ok: true, status: response.status, message: "", retryable: false, payloadRejected: false };
    }
    const body = (await response.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    // 429 and 5xx pass; 4xx means this key, project or payload will not be accepted as is.
    const retryable = response.status === 429 || response.status >= 500;
    return {
      ok: false,
      status: response.status,
      message: `Sentry answered ${response.status}${body ? `: ${body}` : ""}`,
      retryable,
      payloadRejected: PAYLOAD_REJECTED.has(response.status),
    };
  } catch (cause) {
    return {
      ok: false,
      status: null,
      message: `Could not reach Sentry: ${errorMessage(cause)}`,
      retryable: true,
      payloadRejected: false,
    };
  }
}

/** Splits spans into requests of at most MAX_SPANS_PER_REQUEST spans and about MAX_REQUEST_BYTES. */
export function batches(spans: OtlpSpan[]): OtlpSpan[][] {
  const out: OtlpSpan[][] = [];
  let batch: OtlpSpan[] = [];
  let bytes = 0;
  for (const span of spans) {
    const size = Buffer.byteLength(JSON.stringify(span), "utf8");
    if (batch.length > 0 && (batch.length >= MAX_SPANS_PER_REQUEST || bytes + size > MAX_REQUEST_BYTES)) {
      out.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(span);
    bytes += size;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}

/** Sends spans in batches, stopping at the first batch Sentry does not accept. */
export async function sendSpans(
  target: SentryTarget,
  spans: OtlpSpan[],
  resource: ResourceInfo,
  fetchImpl: Fetch = fetch,
): Promise<SendResult> {
  let sent = 0;
  for (const batch of batches(spans)) {
    const result = await post(target, envelope(batch, resource), fetchImpl);
    if (!result.ok) return { ...result, spans: sent };
    sent += batch.length;
  }
  return {
    ok: true,
    status: 200,
    message: `Sent ${sent} span${sent === 1 ? "" : "s"}.`,
    retryable: false,
    payloadRejected: false,
    spans: sent,
  };
}
