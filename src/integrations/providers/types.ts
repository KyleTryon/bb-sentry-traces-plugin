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
 *
 * This file holds the contract constants and the shapes the rest of the
 * integration passes around. The wire schemas are in `schema.ts`.
 */
import type { AttributeValue } from "../../core/otlp.js";

export const CONTRACT_VERSION = 1;
/** The key of a trace's root span, and where a thread hangs when a provider names no parent. */
export const ROOT_KEY = "root";

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

