/**
 * The shapes a trace is built from: its turns, their spans and activity, and
 * the event rows the builder reads. The folding logic is in `builder.ts`.
 */

/** The only event types the trace reads, so history can be filtered. */
export const TRACE_EVENT_TYPES = [
  "client/turn/requested",
  "turn/started",
  "turn/input/accepted",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  // A delegation row's call returning, or its agent ending, arrives here, not as `item/completed`.
  "item/delegation/progress",
  "item/delegation/completed",
  "system/interaction/lifecycle",
  "provider/error",
  "system/error",
  "system/thread/interrupted",
  "provider/modelFallback",
  "provider/rateLimits/updated",
  "thread/contextWindowUsage/updated",
] as const;

export const SPAN_KINDS = [
  "command",
  "tool",
  "read",
  "edit",
  "search",
  "web",
  "subagent",
  "background",
  "waiting",
  "compaction",
  "startup",
  "error",
] as const;
export const STATUSES = ["running", "completed", "failed", "interrupted"] as const;
export const ACTIVITY_KINDS = ["thinking", "writing"] as const;

export type SpanKind = (typeof SPAN_KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** A low-cardinality reason a span failed. Safe to send without content capture. */
export type ErrorType =
  | "tool_error"
  | "interrupted"
  | "provider_error"
  | "bb_error"
  | "never_finished";

export interface Span {
  id: string;
  /** The subagent this ran inside, or null for the turn's own agent. */
  parentId: string | null;
  kind: SpanKind;
  /**
   * A name with no user or model content in it: the tool's own name
   * (`shell`, `Read`, `mcp__docs__search`), `subagent`, `Question`, and so on.
   */
  toolName: string;
  /** A display name. Equal to `toolName` unless content capture is on. */
  name: string;
  /** A short description. Empty unless content capture is on. */
  detail: string;
  start: number;
  /** Null while it runs. */
  end: number | null;
  status: Status;
  /** Runs alongside its agent instead of blocking it, like a dev server or a background subagent. */
  background: boolean;
  /** Tokens a subagent has reported so far; null when the provider reports none. */
  tokens: number | null;
  /**
   * For a subagent: the kind of agent it is, such as `Explore`. One of a small
   * set of names, never the task it was given. Null for everything else.
   */
  agent: string | null;
  /** For a subagent: when the tool call that started it returned. The agent may work on after. */
  callEnd: number | null;
  /** The command's exit code, when it reported one. */
  exitCode: number | null;
  errorType: ErrorType | null;
  /**
   * What went wrong. A tool's own error text is tool output, so it is kept
   * only with content capture; provider and bb errors are always kept.
   */
  error: string | null;
  /** The call's arguments as text. Null unless content capture is on. */
  args: string | null;
  /** The call's output as text. Null unless content capture is on. */
  result: string | null;
  /** The event that started the span. */
  seq: number;
  /** The event that ended it. */
  endSeq: number | null;
}

/** When an agent was visibly thinking or writing its reply. */
export interface Activity {
  id: string;
  /** The subagent it belongs to, or null for the turn's own agent. */
  lane: string | null;
  kind: ActivityKind;
  start: number;
  end: number | null;
}

export interface Turn {
  id: string;
  /** 1-based position among the thread's top-level turns. */
  index: number;
  /** The thread that sent the prompt, or `bb` for bb's own notices; null when the user did. */
  sender: string | null;
  /** The model the turn was requested with, as bb recorded it. */
  model: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
  permissionMode: string | null;
  /** Who started the turn: `user`, `agent` or `system`. */
  initiator: string | null;
  /** How the prompt reached the thread, such as `spawn`. */
  source: string | null;
  /** The model the provider switched to mid-turn, when it did. */
  fallback: { model: string; reason: string | null; at: number } | null;
  /** The provider's latest rate limit status during the turn, such as `allowed` or `warning`. */
  rateLimitStatus: string | null;
  /** The latest context window reading during the turn. */
  context: { usedTokens: number | null; windowTokens: number | null } | null;
  /** The prompt. Null unless content capture is on. */
  input: string | null;
  /** The turn's own agent's replies, oldest first. Empty unless content capture is on. */
  replies: string[];
  start: number;
  /** Null while it runs. */
  end: number | null;
  status: Status;
  /** The provider's error for a failed turn. */
  error: string | null;
  spans: Span[];
  activity: Activity[];
  /** The prompt's event. A queued prompt comes before `firstSeq`. */
  requestSeq: number | null;
  /** The stretch of history the turn ran over, from its `turn/started` to its `turn/completed`. */
  firstSeq: number;
  lastSeq: number;
}

/** The slice of a bb thread event row the trace reads. */
export interface TraceEvent {
  seq: number;
  createdAt: number;
  type: string;
  scope: { kind: string; turnId?: string };
  data: unknown;
}

export interface TraceBuilderOptions {
  /** Keep prompts, replies, arguments and outputs. Off keeps none of them. */
  content: boolean;
  /** How many top-level turns came before the first event this builder will see. */
  indexOffset?: number;
}

/** Per-field caps for captured content, in characters. */
export const MAX_INPUT = 16_000;
export const MAX_REPLY = 16_000;
export const MAX_ARGS = 4_000;
export const MAX_RESULT = 4_000;
