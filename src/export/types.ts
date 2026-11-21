/**
 * The shapes the export works with: settings, what is remembered per thread,
 * stats, the outcome of an export, and the context the export functions share.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type AttributeValue } from "../core/otlp.js";
import { TraceBuilder } from "../core/trace/builder.js";
import { type Turn } from "../core/trace/types.js";
import { type RawUsage } from "../core/usage.js";
import { TraceProviders } from "../integrations/providers/client.js";
import { WorkflowsClient } from "../integrations/workflows/client.js";
import { type Fetch } from "../sentry.js";

export interface ExportSettings {
  dsn: string | undefined;
  enabled: boolean;
  captureContent: boolean;
  environment: string;
  /** Plugin ids to ask which trace a thread belongs to. */
  providers: string[];
}

/** What is remembered about a thread between exports. */
export interface ThreadState {
  /** The index of the last turn sent, or null when none has been. */
  sentTurn: number | null;
  /** Events at or below this sequence never need reading again. */
  resumeSeq: number;
  /** How many top-level turns started at or before `resumeSeq`. */
  turnsBefore: number;
  /** The thread's running token total when it was last looked at. */
  usage: RawUsage | null;
  /** Whether `usage` was actually read, so a null means "none yet", not "unknown". */
  usageKnown: boolean;
  /**
   * Turns at or before `sentTurn` that are not sent yet: held back for a
   * background subagent still at work, or waiting to be sent again.
   */
  waiting?: number[] | null;
  /** Turns sent since `usage` was read whose share of it was not sent yet. */
  usageTurns?: number;
  /**
   * A turn whose spans went out in several requests and stopped part way:
   * the ids of the spans Sentry already has, so they are not sent twice.
   */
  partial?: { turnId: string; spanIds: string[] } | null;
  updatedAt: number;
}

export interface Stats {
  turnsSent: number;
  spansSent: number;
  /** Provider traces whose own spans were sent. */
  tracesSent: number;
  workflowsSent: number;
  failures: number;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}

export interface RetryEntry {
  attempts: number;
  nextAt: number;
}
/** The part of a provider trace that outlives one export. */
export interface TraceRef {
  provider: string;
  traceKey: string;
  pipeline: string | null;
  traceAttributes: Record<string, AttributeValue>;
}

/** A provider trace whose own spans still have to be sent when it ends. */
export interface TraceEntry extends TraceRef {
  firstSeenAt: number;
  /** When the rest of its spans were sent, at its end. */
  sentAt: number | null;
  /** The keys of the spans already sent before the trace ended, because its provider said they were final. */
  sentKeys?: string[] | null;
}

/** A workflow run whose own spans still have to be sent when it ends. */
export interface WorkflowEntry {
  originThreadId: string;
  firstSeenAt: number;
  sentAt: number | null;
  /**
   * The provider trace the workflow belongs to, when it belongs to one, and
   * the span it hangs under when no span of that trace names it.
   */
  trace: (TraceRef & { fallbackParentKey: string }) | null;
}

export type ExportOutcome =
  | { kind: "disabled" | "not-configured" | "nothing" }
  | { kind: "sent"; turns: number; spans: number; traceIds: string[] }
  | { kind: "failed"; message: string; retryable: boolean };

export interface ExporterDeps {
  bb: Pick<BbPluginApi, "sdk" | "log" | "storage">;
  settings: () => Promise<ExportSettings>;
  fetch?: Fetch;
  now?: () => number;
}

/** A thread's turns and what the next export needs to know to continue from here. */
export interface Folded {
  turns: Turn[];
  builder: TraceBuilder;
  truncated: boolean;
}

/** What the export functions share: bb, the trace providers, and the clock. */
export interface ExportContext {
  bb: ExporterDeps["bb"];
  settings: () => Promise<ExportSettings>;
  fetch: Fetch | undefined;
  now: () => number;
  providers: TraceProviders;
  workflows: WorkflowsClient;
  /** Read-modify-write of a shared storage key, one at a time. */
  locks: Map<string, Promise<unknown>>;
  /** Whether 0.1.0's one-map-per-kind records have been moved over this run. */
  migrated: boolean;
}
