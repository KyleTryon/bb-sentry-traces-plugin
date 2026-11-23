/**
 * Trace providers. Any bb plugin can say "these threads belong to one trace of
 * mine, and here is that trace's own structure" by calling two RPC methods of
 * this plugin, described in docs/trace-provider-contract.md:
 *
 * - `report_threads`: which trace a thread belongs to, where its turns hang,
 *   and which agent it runs as;
 * - `report_trace`: the trace's own spans, as a whole snapshot each time.
 *
 * This plugin knows nothing about what a provider's trace means, and asks no
 * other plugin anything. A provider pushes what it knows; the export reads
 * what was stored when a thread goes idle and on its periodic sweep. A thread
 * no provider claimed exports on its own.
 *
 * This file holds the contract constants and the shapes the rest of the
 * integration passes around. The wire schemas are in `schema.ts`.
 */
import type { AttributeValue } from "../../core/otlp.js";

export const CONTRACT_VERSION = 2;
/** The key of a trace's root span, and where a thread hangs when a provider names no parent. */
export const ROOT_KEY = "root";

/** Where a thread sits in a provider's trace. */
export interface TraceContext {
  /** The plugin that claimed the thread. */
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

/** A thread's claim as stored: whose it is, where it puts the thread, and when it was made. */
export interface StoredClaim {
  context: TraceContext;
  reportedAt: number;
}

/** What is remembered of a provider, for `status`. */
export interface ProviderRecord {
  lastReportAt: number;
}
