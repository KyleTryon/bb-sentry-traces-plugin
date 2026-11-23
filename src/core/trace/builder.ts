/**
 * Turns a thread's raw bb events into a trace: one entry per top-level turn,
 * each holding the commands, tool calls, subagents, waits, and errors that
 * happened inside it, plus when its agents were visibly thinking or writing.
 *
 * Subagents run as turns of their own whose `turn/started` points at the
 * delegating tool call, or as items and agent tasks that point at it, so
 * their work folds back into the turn that spawned them. A call is a
 * subagent by that shape, whatever its provider names the tool.
 *
 * Adapted from bb-plugin-agent-traces (https://github.com/charpeni/bb-plugins,
 * plugins/agent-traces/trace.ts), MIT License, Copyright (c) 2026 Nicolas
 * Charpentier. See THIRD_PARTY_NOTICES.md.
 *
 * Changes from the original:
 * - Each turn keeps the model, reasoning level and service tier it was
 *   requested with.
 * - A `content` switch. When it is off the builder keeps no prompt, reply,
 *   command line, tool argument, tool output, file name or model-written
 *   label: only tool names, timing, status and exit codes. When it is on it
 *   keeps the prompt, the replies, and each call's arguments and result.
 * - Every span has a `toolName` that is safe to send without content: a tool
 *   or agent name that is not a plain identifier becomes `tool` or
 *   `subagent` then. Provider and bb error text is kept without content only
 *   when it reads as a code, such as `overloaded_error`.
 * - A subagent keeps the tool that started it, the kind of agent it is, and
 *   when that tool call returned, so it can be reported as a tool call that
 *   hands work to another agent.
 * - Each turn keeps who started it, its permission mode, a model fallback,
 *   the provider's rate limit status and how full the context window got.
 * - A turn index offset and the unmatched-request cursor, so a thread can be
 *   folded from where the last export stopped instead of from its start.
 * - Child-thread spans and chat links are gone; this plugin does not use them.
 * - Captured text is scrubbed for secrets before it is cut.
 * - A turn remembers when the turn before it ended even when that turn began
 *   before this fold did, so a queued prompt's wait is not counted as startup.
 * - Subagents are found by what runs under a call rather than by tool name,
 *   and `delegation` rows' own progress and completion events are read.
 */
import {
  agentKindIn,
  describe,
  describeInteraction,
  errorMessageOf,
  errorOf,
  errorText,
  SUBAGENT,
} from "./describe.js";
import {
  MAX_INPUT,
  MAX_REPLY,
  MAX_RESULT,
  type Activity,
  type ActivityKind,
  type Span,
  type SpanKind,
  type Status,
  type Turn,
  type TraceBuilderOptions,
  type TraceEvent,
} from "./types.js";
import { scrub, scrubTail } from "../scrub/cut.js";
import { scrubValue } from "../scrub/value.js";
import { record, text, type Json } from "../text.js";

// Shorter startups are just the provider's own latency.
const MIN_STARTUP_MS = 300;
// After this long without a single event, nothing in the thread is still
// running; a turn without one of its own for this long is over too.
const STALE_MS = 6 * 60 * 60 * 1_000;
const SKIPPED_ITEMS = new Set(["userMessage", "plan", "planSteps"]);
const ACTIVITY_ITEMS: Record<string, ActivityKind> = {
  reasoning: "thinking",
  agentMessage: "writing",
};
/** Background task types that are a subagent's own run, as bb's `isBackgroundAgentTaskType` says. */
const AGENT_TASK_TYPES = new Set(["local_agent", "local_subagent"]);
/** Span kinds a later event can turn into a subagent: calls, not commands or edits. */
const DELEGATING_KINDS = new Set<SpanKind>(["tool"]);

interface Request {
  input: string | null;
  sender: string | null;
  model: string | null;
  reasoningLevel: string | null;
  serviceTier: string | null;
  permissionMode: string | null;
  initiator: string | null;
  source: string | null;
  seq: number;
  at: number;
  matched: boolean;
}
type TurnState = Omit<Turn, "spans" | "activity"> & {
  spanIds: string[];
  activityIds: string[];
  /** When the turn last had an event, for turns that never finished. */
  lastAt: number;
  /**
   * When the latest turn that ended before this one started ended, including
   * a turn that began before this fold did and so is not in it.
   */
  previousEnd: number | null;
};

function itemStatus(value: unknown): Status {
  if (value === "pending") return "running";
  if (value === "failed" || value === "interrupted") return value;
  return "completed";
}

/** Why a call with this status failed, or its earlier reason when it did not. */
function errorTypeFor(status: Status, earlier: Span["errorType"]): Span["errorType"] {
  if (status === "failed") return "tool_error";
  if (status === "interrupted") return "interrupted";
  return earlier;
}

const THREAD_MESSAGE_PREFIX = /^\s*\[bb message from thread:([^\]\s]+)\]\s*/;
// bb's own notices, such as a spawned thread finishing, arrive as prompts too.
const SYSTEM_MESSAGE_PREFIX = /^\s*\[bb system\]\s*/;
/** The sender of a prompt that bb itself sent. */
const BB_SENDER = "bb";

/**
 * Folds thread events into turns. Events at or below the last folded `seq`
 * are ignored, so re-applying an overlapping page is harmless.
 */
export class TraceBuilder {
  lastSeq = 0;
  private readonly content: boolean;
  private readonly indexOffset: number;
  /** When the thread's latest event happened. */
  private lastEventAt = 0;
  private readonly turns = new Map<string, TurnState>();
  /** Any turn id, including subagent turns, to the top-level turn it belongs to. */
  private readonly rootTurn = new Map<string, string>();
  /** A subagent turn to the tool call that started it. */
  private readonly turnParent = new Map<string, string>();
  private readonly spans = new Map<string, Span>();
  /** A span to the top-level turn it belongs to. */
  private readonly spanTurn = new Map<string, string>();
  private readonly activities = new Map<string, Activity>();
  private readonly requests = new Map<string, Request>();
  /** Subagent tokens that arrived before their span. */
  private readonly pendingTokens = new Map<string, number>();
  /** Subagents whose agent is still working after its tool call returned. */
  private readonly runningAgents = new Set<string>();
  /**
   * Calls that something ran under: a subagent turn, an agent task, or items
   * of their own. Whatever the tool is called, such a call handed work to
   * another agent. Kept by id, since the pointer can come before the call.
   */
  private readonly delegators = new Set<string>();
  /** The agent kind a tool call's arguments name, for when it turns out to be a subagent. */
  private readonly kindHints = new Map<string, string>();
  /**
   * A span or activity to the tool call it ran under. Its subagent is looked
   * up when the trace is read, so a call recorded before its subagent's own
   * tool call still nests under it.
   */
  private readonly via = new Map<string, string>();
  /** The top-level turn that is running, for events bb records outside any turn. */
  private activeTurn: string | null = null;
  /**
   * When the latest top-level turn ended, as far as this fold can tell. A turn
   * that began before the fold is unknown here, but its end still counts.
   */
  private lastTurnEnd: number | null = null;
  /**
   * Subagent turns whose tool call this fold never saw, taken as top-level
   * turns. One may run beside the real turns, so it is never closed by them.
   */
  private readonly detached = new Set<string>();

  constructor(options: TraceBuilderOptions) {
    this.content = options.content;
    this.indexOffset = options.indexOffset ?? 0;
  }

  /** The top-level turn that is running as of the last event applied, if any. */
  get runningTurn(): string | null {
    return this.activeTurn;
  }

  /** Whether a top-level turn has started and not ended, as of the last event applied. */
  isRunning(turnId: string): boolean {
    return this.turns.get(turnId)?.end === null;
  }

  apply(events: readonly TraceEvent[]): void {
    for (const event of events) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      this.lastEventAt = Math.max(this.lastEventAt, event.createdAt);
      this.fold(event);
    }
  }

  /**
   * The sequence of the earliest prompt sent at or after `since` that no turn
   * has accepted yet. A later fold has to start before it to know that turn's
   * prompt and model.
   */
  earliestUnmatchedRequest(since: number): number | null {
    let earliest: number | null = null;
    for (const request of this.requests.values()) {
      if (request.matched || request.at < since) continue;
      if (earliest === null || request.seq < earliest) earliest = request.seq;
    }
    return earliest;
  }

  /**
   * Top-level turns, oldest first. A call cannot outlive its finished turn
   * without saying so, and after hours of silence nothing is still running:
   * those close as interrupted instead of growing with the clock. So does a
   * turn with no event of its own for hours, though other events, such as a
   * background agent of an earlier turn reporting, keep the thread busy.
   */
  snapshot(now?: number): Turn[] {
    const quiet = now !== undefined && now - this.lastEventAt > STALE_MS;
    return [...this.turns.values()].map(({ spanIds, activityIds, lastAt, previousEnd: _previousEnd, ...turn }) => {
      const stale = quiet || (now !== undefined && turn.end === null && now - lastAt > STALE_MS);
      const end = turn.end ?? (stale ? lastAt : null);
      const close = <T extends { start: number; end: number | null }>(
        item: T,
        background: boolean,
      ): T =>
        item.end !== null || end === null || (background && !stale)
          ? item
          : { ...item, end: Math.max(item.start, end) };
      return {
        ...turn,
        replies: [...turn.replies],
        end,
        status: turn.end === null && stale ? "interrupted" : turn.status,
        spans: spanIds.flatMap((id) => {
          const stored = this.spans.get(id);
          if (!stored) return [];
          const span = close(stored, stored.background);
          const closed = span !== stored;
          return [
            {
              ...span,
              parentId: this.subagentLane(this.via.get(id) ?? ""),
              status: closed ? "interrupted" : span.status,
              errorType: closed ? (span.errorType ?? "never_finished") : span.errorType,
            },
          ];
        }),
        activity: activityIds.flatMap((id) => {
          const activity = this.activities.get(id);
          if (!activity) return [];
          return [close({ ...activity, lane: this.subagentLane(this.via.get(id) ?? "") }, false)];
        }),
      };
    });
  }

  private fold(event: TraceEvent): void {
    const data = record(event.data);
    const turnId = event.scope.turnId;
    switch (event.type) {
      case "client/turn/requested": {
        const requestId = text(data['requestId']);
        if (!requestId) return;
        const input = Array.isArray(data['input']) ? data['input'] : [];
        const parts = input.map((part) => text(record(part)['text'])).filter(Boolean);
        // bb prefixes messages from other threads and its own notices.
        const first = parts[0] ?? "";
        const prefix = THREAD_MESSAGE_PREFIX.exec(first);
        const system = prefix ? null : SYSTEM_MESSAGE_PREFIX.exec(first);
        const execution = record(data['execution']);
        this.requests.set(requestId, {
          input: this.content ? scrub(parts.join("\n\n"), MAX_INPUT) : null,
          sender: text(data['senderThreadId']) || prefix?.[1] || (system ? BB_SENDER : null),
          model: text(execution['model']) || null,
          reasoningLevel: text(execution['reasoningLevel']) || null,
          serviceTier: text(execution['serviceTier']) || null,
          permissionMode: text(execution['permissionMode']) || null,
          initiator: text(data['initiator']) || null,
          source: text(data['source']) || null,
          seq: event.seq,
          at: event.createdAt,
          matched: false,
        });
        return;
      }
      case "turn/started":
        if (turnId) this.startTurn(turnId, text(data['parentToolCallId']), event);
        return;
      case "turn/input/accepted": {
        const turn = turnId ? this.turns.get(turnId) : undefined;
        const request = this.requests.get(text(data['clientRequestId']));
        if (turn && request && turn.requestSeq === null) this.acceptRequest(turn, request, event);
        return;
      }
      case "turn/completed": {
        const turn = turnId ? this.turns.get(turnId) : undefined;
        // A known subagent turn ending is not its top-level turn ending. An
        // unknown turn is most likely the top-level turn the fold began inside.
        if (turn || (turnId && !this.rootTurn.has(turnId))) {
          this.lastTurnEnd = Math.max(this.lastTurnEnd ?? event.createdAt, event.createdAt);
        }
        if (!turn) return;
        this.touch(turn, event.seq, event.createdAt);
        turn.end = event.createdAt;
        turn.status = itemStatus(data['status']);
        const message = errorMessageOf(data);
        turn.error = errorText(message, [message], this.content);
        if (this.activeTurn === turn.id) this.activeTurn = null;
        return;
      }
      case "item/started":
      case "item/completed":
      case "item/backgroundTask/progress":
      case "item/backgroundTask/completed":
      case "item/delegation/progress":
      case "item/delegation/completed":
        this.foldItem(turnId, record(data['item']), event);
        return;
      case "system/interaction/lifecycle":
        this.foldInteraction(turnId, record(data['interaction']), event);
        return;
      case "provider/error": {
        const parts = [text(data['message']), text(data['detail'])];
        this.addMarker(turnId, event, {
          toolName: "Provider error",
          errorType: "provider_error",
          error: errorText(parts.filter(Boolean).join(": "), parts, this.content),
          status: "failed",
        });
        return;
      }
      case "system/error": {
        const parts = [text(data['message']), text(data['code'])];
        this.addMarker(turnId, event, {
          toolName: "bb error",
          errorType: "bb_error",
          error: errorText(parts[0] || parts[1] || "", parts, this.content),
          status: "failed",
        });
        return;
      }
      case "system/thread/interrupted": {
        const reason = text(data['reason']);
        this.addMarker(turnId, event, {
          toolName: "Stopped",
          errorType: "interrupted",
          error: errorText(reason, [reason], this.content),
          status: "interrupted",
        });
        return;
      }
      case "provider/modelFallback": {
        const turn = this.turnFor(turnId);
        const model = text(data['fallbackModel']);
        if (turn && model) {
          // Without content, only a reason that reads as a code: free text may quote the prompt.
          const reason = text(data['reason']);
          turn.fallback = { model, reason: errorText(reason, [reason], this.content), at: event.createdAt };
        }
        return;
      }
      case "provider/rateLimits/updated": {
        const turn = this.turnFor(turnId);
        const status = text(record(data['rateLimits'])['status']);
        if (turn && status) turn.rateLimitStatus = status;
        return;
      }
      case "thread/contextWindowUsage/updated": {
        const turn = this.turnFor(turnId);
        if (!turn) return;
        const usage = record(data['contextWindowUsage']);
        const snapshot = record(usage['snapshot']);
        const number = (...values: unknown[]) =>
          values.find((value): value is number => typeof value === "number") ?? null;
        const usedTokens = number(usage['usedTokens'], snapshot['usedTokens']);
        const windowTokens = number(usage['modelContextWindow'], snapshot['contextWindowTokens']);
        if (usedTokens !== null || windowTokens !== null) turn.context = { usedTokens, windowTokens };
        return;
      }
    }
  }

  private touch(turn: TurnState, seq: number, at: number): void {
    // Background work reporting after the turn ended does not stretch it.
    if (turn.end === null) turn.lastSeq = Math.max(turn.lastSeq, seq);
    turn.lastAt = Math.max(turn.lastAt, at);
  }

  /** The top-level turn an event belongs to, by its scope or by what was running. */
  private turnFor(turnId: string | undefined): TurnState | undefined {
    const root = turnId ? this.rootTurn.get(turnId) : this.activeTurn;
    return root ? this.turns.get(root) : undefined;
  }

  private startTurn(turnId: string, parentToolCallId: string, event: TraceEvent): void {
    // A subagent's turn can be recorded before the tool call that started it;
    // it still belongs to the turn that is running.
    const parentTurn = parentToolCallId
      ? (this.spanTurn.get(parentToolCallId) ?? this.activeTurn ?? undefined)
      : undefined;
    if (parentToolCallId) this.noteDelegator(parentToolCallId);
    if (parentTurn) {
      this.rootTurn.set(turnId, parentTurn);
      this.turnParent.set(turnId, parentToolCallId);
      return;
    }
    if (this.turns.has(turnId)) return;
    if (parentToolCallId) this.detached.add(turnId);
    else this.interruptRunning();
    this.rootTurn.set(turnId, turnId);
    this.activeTurn = turnId;
    this.turns.set(turnId, {
      id: turnId,
      index: this.indexOffset + this.turns.size + 1,
      sender: null,
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null,
      initiator: null,
      source: null,
      fallback: null,
      rateLimitStatus: null,
      context: null,
      input: null,
      replies: [],
      start: event.createdAt,
      end: null,
      status: "running",
      error: null,
      requestSeq: null,
      firstSeq: event.seq,
      lastSeq: event.seq,
      spanIds: [],
      activityIds: [],
      lastAt: event.createdAt,
      previousEnd: this.lastTurnEnd,
    });
  }

  /**
   * bb runs one top-level turn of a thread at a time, so a turn that starts
   * ends the one before it. One still running then never said it ended (bb
   * stopped, or its provider was killed): it ends as interrupted at its last
   * event, instead of running forever and holding every later read back.
   */
  private interruptRunning(): void {
    const running = this.activeTurn ? this.turns.get(this.activeTurn) : undefined;
    if (!running || running.end !== null || this.detached.has(running.id)) return;
    running.end = running.lastAt;
    running.status = "interrupted";
    this.lastTurnEnd = Math.max(this.lastTurnEnd ?? running.lastAt, running.lastAt);
  }

  /**
   * Links the prompt to its turn, and counts the wait between sending it and
   * the agent starting as part of the turn, unless an earlier turn held it up.
   */
  private acceptRequest(turn: TurnState, request: Request, event: TraceEvent): void {
    request.matched = true;
    turn.input = request.input;
    turn.sender = request.sender;
    turn.model = request.model;
    turn.reasoningLevel = request.reasoningLevel;
    turn.serviceTier = request.serviceTier;
    turn.permissionMode = request.permissionMode;
    turn.initiator = request.initiator;
    turn.source = request.source;
    turn.requestSeq = request.seq;
    this.touch(turn, request.seq, request.at);
    const previous = [...this.turns.values()].find((other) => other.index === turn.index - 1);
    const from = Math.max(request.at, previous?.end ?? -Infinity, turn.previousEnd ?? -Infinity);
    if (turn.start - from < MIN_STARTUP_MS) return;
    const id = `startup:${turn.id}`;
    this.spans.set(id, {
      ...this.blankSpan(id, request.seq),
      kind: "startup",
      toolName: "Starting",
      name: "Starting",
      start: from,
      end: turn.start,
      status: "completed",
      endSeq: event.seq,
    });
    this.spanTurn.set(id, turn.id);
    turn.spanIds.unshift(id);
    turn.start = from;
  }

  private blankSpan(id: string, seq: number): Span {
    return {
      id,
      parentId: null,
      kind: "tool",
      toolName: "",
      name: "",
      detail: "",
      start: 0,
      end: null,
      status: "running",
      background: false,
      tokens: null,
      agent: null,
      callEnd: null,
      exitCode: null,
      errorType: null,
      error: null,
      args: null,
      result: null,
      seq,
      endSeq: null,
    };
  }

  private addSpan(turn: TurnState, span: Span): void {
    this.spans.set(span.id, span);
    this.spanTurn.set(span.id, turn.id);
    turn.spanIds.push(span.id);
  }

  private addMarker(
    turnId: string | undefined,
    event: TraceEvent,
    marker: Pick<Span, "toolName" | "errorType" | "error" | "status">,
  ): void {
    const turn = this.turnFor(turnId);
    if (!turn) return;
    this.touch(turn, event.seq, event.createdAt);
    this.addSpan(turn, {
      ...this.blankSpan(`marker:${event.seq}`, event.seq),
      kind: "error",
      ...marker,
      name: marker.toolName,
      error: marker.error,
      start: event.createdAt,
      end: event.createdAt,
      endSeq: event.seq,
    });
  }

  /** Approvals, questions, and other forms that wait on the user. */
  private foldInteraction(turnId: string | undefined, interaction: Json, event: TraceEvent): void {
    const interactionId = text(interaction['id']);
    if (!interactionId) return;
    const id = `interaction:${interactionId}`;
    const status = text(interaction['status']);
    // Still waiting: asked, or answered and on its way to the agent.
    const waiting = status === "pending" || status === "resolving";
    const existing = this.spans.get(id);
    if (existing) {
      if (waiting || existing.end !== null) return;
      const turn = this.turns.get(this.spanTurn.get(id) ?? "");
      if (turn) this.touch(turn, event.seq, event.createdAt);
      existing.end = Math.max(event.createdAt, existing.start);
      existing.endSeq = event.seq;
      existing.status = status === "resolved" ? "completed" : "interrupted";
      existing.errorType = status === "resolved" ? null : "interrupted";
      return;
    }
    const turn = this.turnFor(turnId);
    if (status !== "pending" || !turn) return;
    this.touch(turn, event.seq, event.createdAt);
    this.addSpan(turn, {
      ...this.blankSpan(id, event.seq),
      kind: "waiting",
      ...describeInteraction(record(interaction['payload']), this.content),
      start: event.createdAt,
    });
  }

  private foldItem(turnId: string | undefined, item: Json, event: TraceEvent): void {
    const id = text(item['id']);
    const type = text(item['type']);
    if (!id || SKIPPED_ITEMS.has(type)) return;
    const parentToolCallId =
      text(item['parentToolCallId']) || (turnId && this.turnParent.get(turnId)) || "";
    // Background tasks report completion outside any turn; find their turn
    // through the span itself or the tool call that started it.
    const root = turnId
      ? this.rootTurn.get(turnId)
      : (this.spanTurn.get(id) ?? this.spanTurn.get(parentToolCallId));
    const turn = root ? this.turns.get(root) : undefined;
    if (!turn) return;
    this.touch(turn, event.seq, event.createdAt);

    const agentTask = type === "backgroundTask" && AGENT_TASK_TYPES.has(text(item['taskType']));
    // A command's own background task, such as a dev server, is not the work
    // of another agent; anything else that ran under a call is.
    if (parentToolCallId && (type !== "backgroundTask" || agentTask)) {
      this.noteDelegator(parentToolCallId);
    }

    const activity = ACTIVITY_ITEMS[type];
    if (activity !== undefined) {
      this.foldActivity(turn, id, activity, parentToolCallId, event);
      // Only the turn's own agent writes the replies the user reads.
      if (
        this.content &&
        type === "agentMessage" &&
        event.type === "item/completed" &&
        !parentToolCallId
      ) {
        const reply = text(item['text']).trim();
        if (reply) turn.replies.push(scrubTail(reply, MAX_REPLY));
      }
      return;
    }
    if (agentTask) {
      this.foldSubagentTask(parentToolCallId, item, event);
      return;
    }
    // Only completions of other background tasks matter; their progress does not.
    if (event.type === "item/backgroundTask/progress") return;

    // A delegation's progress says it is still running, as bb's own timeline reads it.
    const finished = event.type !== "item/started" && event.type !== "item/delegation/progress";
    const existing = this.spans.get(id);
    if (existing) {
      if (!finished) return;
      this.noteCallEnd(existing, event);
      // Its call returned while its agent works on: the agent runs in the background.
      if (this.runningAgents.has(id)) existing.background = true;
      else this.finish(existing, item, event);
      return;
    }
    const description = describe(item, this.content);
    if (parentToolCallId) this.via.set(id, parentToolCallId);
    const span: Span = {
      ...this.blankSpan(id, event.seq),
      parentId: this.subagentLane(parentToolCallId),
      ...description,
      start: event.createdAt,
      tokens: this.pendingTokens.get(id) ?? null,
    };
    this.pendingTokens.delete(id);
    if (type === "toolCall") {
      const hint = agentKindIn(record(item['arguments']));
      if (hint) this.kindHints.set(id, hint);
    }
    this.addSpan(turn, span);
    if (this.delegators.has(id)) this.promote(span);
    if (finished) {
      this.noteCallEnd(span, event);
      this.finish(span, item, event);
    }
  }

  /** Something ran under the call `id`, so that call handed work to another agent. */
  private noteDelegator(id: string): void {
    this.delegators.add(id);
    const span = this.spans.get(id);
    if (span) this.promote(span);
  }

  /**
   * Turns a tool call into a subagent once something is seen running under
   * it, whatever the provider calls the tool: a forked Skill, OpenCode's
   * `task`, a tool this plugin has never heard of. Its kind comes from its
   * arguments, else it is a plain `subagent`.
   */
  private promote(span: Span): void {
    if (!DELEGATING_KINDS.has(span.kind)) return;
    const agent = this.kindHints.get(span.id) ?? SUBAGENT;
    span.kind = "subagent";
    span.agent = agent;
    span.name = agent;
    // Its call already returned: that is when the handoff ended.
    if (span.end !== null) span.callEnd = span.end;
  }

  /** A subagent's tool call returned; its agent may still be working. */
  private noteCallEnd(span: Span, event: TraceEvent): void {
    if (span.kind !== "subagent" || span.callEnd !== null) return;
    span.callEnd = Math.max(event.createdAt, span.start);
  }

  private finish(span: Span, item: Json, event: TraceEvent): void {
    span.end = Math.max(event.createdAt, span.start);
    span.endSeq = event.seq;
    span.status = itemStatus(item['status']);
    if (typeof item['exitCode'] === "number") span.exitCode = item['exitCode'];
    span.errorType = errorTypeFor(span.status, span.errorType);
    if (!this.content) return;
    // A tool's error text and output are tool output.
    span.error = errorOf(item) ?? span.error;
    const result = scrubValue(item['aggregatedOutput'] ?? item['result'], MAX_RESULT);
    if (result) span.result = result;
  }

  private foldActivity(
    turn: TurnState,
    id: string,
    kind: ActivityKind,
    parentToolCallId: string,
    event: TraceEvent,
  ): void {
    const lane = this.subagentLane(parentToolCallId);
    const existing = this.activities.get(id);
    const finished = event.type === "item/completed";
    if (parentToolCallId) this.via.set(id, parentToolCallId);
    if (existing) {
      if (finished) existing.end = Math.max(event.createdAt, existing.start);
    } else {
      this.activities.set(id, {
        id,
        lane,
        kind,
        start: event.createdAt,
        end: finished ? event.createdAt : null,
      });
      turn.activityIds.push(id);
    }
  }

  /** The nearest enclosing subagent, so spans nest only under subagents. */
  private subagentLane(parentToolCallId: string): string | null {
    let cursor = parentToolCallId;
    for (let depth = 0; cursor && depth < 32; depth++) {
      if (this.spans.get(cursor)?.kind === "subagent") return cursor;
      cursor = this.via.get(cursor) ?? "";
    }
    return null;
  }

  /**
   * A subagent's agent task: its tool call can return at once while the agent
   * keeps working in the background, so the task says when it really ends.
   */
  private foldSubagentTask(spanId: string, item: Json, event: TraceEvent): void {
    this.recordSubagentUsage(spanId, record(item['usage']));
    const span = this.spans.get(spanId);
    if (!span) return;
    const status = itemStatus(item['status']);
    const finished = event.type === "item/backgroundTask/completed" || status !== "running";
    if (!finished) {
      // Its call already returned, so the agent runs in the background.
      if (span.endSeq !== null && !this.runningAgents.has(spanId)) span.background = true;
      this.runningAgents.add(spanId);
      span.end = null;
      span.status = "running";
      return;
    }
    this.runningAgents.delete(spanId);
    span.end = Math.max(event.createdAt, span.end ?? span.start);
    span.endSeq = event.seq;
    span.status = status;
    span.errorType = errorTypeFor(status, span.errorType);
  }

  private recordSubagentUsage(spanId: string, usage: Json): void {
    const tokens = usage['totalTokens'];
    if (!spanId || typeof tokens !== "number") return;
    const span = this.spans.get(spanId);
    if (span) span.tokens = tokens;
    else this.pendingTokens.set(spanId, tokens);
  }
}
