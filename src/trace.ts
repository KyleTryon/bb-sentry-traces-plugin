/**
 * Turns a thread's raw bb events into a trace: one entry per top-level turn,
 * each holding the commands, tool calls, subagents, waits, and errors that
 * happened inside it, plus when its agents were visibly thinking or writing.
 *
 * Subagents run as turns of their own whose `turn/started` points at the
 * delegating tool call, so their work folds back into the turn that spawned
 * them.
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
 * - Every span has a `toolName` that is safe to send either way.
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
 */
import { scrub, scrubLine, scrubTail } from "./scrub.js";
import { record, text, type Json } from "./util.js";

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

const MAX_TEXT = 160;
const MAX_ERROR = 300;
/** Per-field caps for captured content, in characters. */
export const MAX_INPUT = 16_000;
export const MAX_REPLY = 16_000;
export const MAX_ARGS = 4_000;
export const MAX_RESULT = 4_000;
// Shorter startups are just the provider's own latency.
const MIN_STARTUP_MS = 300;
// After this long without a single event, nothing in the thread is still running.
const STALE_MS = 6 * 60 * 60 * 1_000;
const SKIPPED_ITEMS = new Set(["userMessage", "plan", "planSteps"]);
const ACTIVITY_ITEMS: Record<string, ActivityKind> = {
  reasoning: "thinking",
  agentMessage: "writing",
};
const SUBAGENT_TOOLS = new Set(["Agent", "Task"]);
/** Background task types that are a subagent's own run, as bb's `isBackgroundAgentTaskType` says. */
const AGENT_TASK_TYPES = new Set(["local_agent", "local_subagent"]);

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

/**
 * One line of text, scrubbed before it is cut so a cut cannot hide a secret's
 * shape. All kept text is scrubbed here, and again when it is sent.
 */
function clip(value: string, max = MAX_TEXT): string {
  return scrubLine(value, max);
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function itemStatus(value: unknown): Status {
  if (value === "pending") return "running";
  if (value === "failed" || value === "interrupted") return value;
  return "completed";
}

/** Codex wraps commands in `/bin/bash -lc "…"`; show what actually ran. */
function unwrapCommand(command: unknown): string {
  const raw = Array.isArray(command) ? command.map(text).join(" ") : text(command);
  const wrapped = /^\/bin\/(?:ba|z)?sh -lc (["'])([\s\S]*)\1$/.exec(raw.trim());
  return wrapped ? wrapped[2] : raw;
}

const SETUP_COMMANDS = new Set(["cd", "export", "set", "source", ".", "mkdir", "true", ":"]);
const SHELL_KEYWORDS = new Set(["for", "while", "until", "if", "case", "do", "then", "{", "("]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A heredoc's body is data, not commands to name the span after. The rest of
// its first line stays (`cat <<EOF > file`, `cat <<EOF | kubectl apply -f -`),
// and the marker becomes a `<<…` word that no heredoc pattern matches again.
const HEREDOC =
  /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
// A heredoc whose terminator was cut off, as in a clipped command, runs to the end.
const UNTERMINATED_HEREDOC = /<<-?[ \t]*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1([^\n]*)\n[\s\S]*$/;
const HEREDOC_WORD = "<<…";
const THREAD_MESSAGE_PREFIX = /^\s*\[bb message from thread:([^\]\s]+)\]\s*/;
// bb's own notices, such as a spawned thread finishing, arrive as prompts too.
const SYSTEM_MESSAGE_PREFIX = /^\s*\[bb system\]\s*/;
/** The sender of a prompt that bb itself sent. */
export const BB_SENDER = "bb";

/**
 * `cat > file`, `echo … > file`, and `tee` only write a file for the next
 * step, and `cat <<EOF | …` only hands text to the next program.
 */
function writesFile(words: string[]): boolean {
  if (words[0] === "tee") return true;
  if (words[0] === "cat" && words.includes(HEREDOC_WORD)) return true;
  return ["cat", "echo", "printf"].includes(words[0]) && words.some((word) => word.startsWith(">"));
}

/**
 * Splits a command line into simple commands, each a list of words, the way a
 * shell would: quotes, `$(…)`, backticks, and line continuations keep their
 * contents together, and `&&`, `||`, `|`, `;`, `&`, and newlines separate.
 */
export function shellCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];
    if (char === "'") {
      const close = command.indexOf(char, index + 1);
      const end = close === -1 ? command.length : close;
      word += command.slice(index + 1, end);
      inWord = true;
      index = end;
    } else if (char === '"') {
      // Inside double quotes, a backslash escapes `"`, `\\`, `$`, and backticks.
      let end = index + 1;
      for (; end < command.length && command[end] !== '"'; end++) {
        if (command[end] === "\\" && '"\\$`'.includes(command[end + 1] ?? "x")) end++;
        word += command[end] ?? "";
      }
      inWord = true;
      index = end;
    } else if ((char === "$" && next === "(") || char === "`") {
      // Command substitution stays one word, nested parentheses included.
      let depth = 0;
      let end = index;
      for (; end < command.length; end++) {
        const current = command[end];
        if (char === "`" ? current === "`" && end > index : current === ")" && --depth === 0) break;
        if (char !== "`" && current === "(") depth++;
      }
      word += command.slice(index, end + 1);
      inWord = true;
      index = end;
    } else if (char === "\\") {
      if (next !== "\n") {
        word += next ?? "";
        inWord = true;
      }
      index++;
    } else if (char === "&" && (command[index - 1] === ">" || next === ">")) {
      // A redirection such as `2>&1` or `&>`, not a separator.
      word += char;
      inWord = true;
    } else if (char === "\n" || char === ";" || char === "&" || char === "|") {
      endCommand();
      if ((char === "&" || char === "|") && next === char) index++;
    } else if (/\s/.test(char)) {
      endWord();
    } else if ((char === "(" || char === ")" || char === "{" || char === "}") && !inWord) {
      endCommand();
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

/**
 * The words of the part of a command line that matters, past `cd x &&`,
 * `VAR=value`, and file setup. Empty for a shell loop or conditional.
 */
export function commandWords(command: string): string[] {
  for (const words of shellCommands(
    command
      .replace(HEREDOC, `${HEREDOC_WORD}$3`)
      .replace(UNTERMINATED_HEREDOC, `${HEREDOC_WORD}$2`),
  )) {
    const meaningful = words.filter((word) => !ASSIGNMENT.test(word));
    const program = meaningful[0];
    if (
      !program ||
      program.startsWith("-") ||
      SETUP_COMMANDS.has(program) ||
      writesFile(meaningful)
    )
      continue;
    // A loop, a conditional, or a function definition (`spawn() {`) is shell code, not one program.
    return SHELL_KEYWORDS.has(program) || program.endsWith("()") ? [] : meaningful;
  }
  return [];
}

/** The program a command line is about. */
function programOf(command: string): string {
  const [program] = commandWords(command);
  return (program && basename(program)) || "shell";
}

interface Description {
  kind: SpanKind;
  toolName: string;
  name: string;
  detail: string;
  background: boolean;
  args: string | null;
  agent: string | null;
}

/** The fallback name of a subagent whose kind is unknown. */
export const SUBAGENT = "subagent";

/**
 * A subagent's kind, when it is a plain identifier. It becomes an agent name
 * in Sentry, which has to be one of a small set, so free text is refused.
 */
function agentKind(value: unknown): string {
  const kind = text(value).trim();
  return /^[\w.:@/-]{1,64}$/.test(kind) ? kind : SUBAGENT;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Names a call. With `content` off, every field is fixed text or the tool's
 * own name: nothing the user or the model wrote.
 */
function describe(item: Json, content: boolean): Description {
  const title = content ? text(record(item.presentation).title) : "";
  const plain = (kind: SpanKind, toolName: string): Description => ({
    kind,
    toolName,
    name: toolName,
    detail: "",
    background: false,
    args: null,
    agent: null,
  });
  switch (item.type) {
    case "commandExecution": {
      const base = plain("command", "shell");
      if (!content) return base;
      const command = unwrapCommand(item.command);
      return {
        ...base,
        name: programOf(command),
        detail: clip(command),
        args: scrub(command.trim(), MAX_ARGS),
      };
    }
    case "fileRead": {
      const base = plain("read", "Read");
      if (!content) return base;
      const path = text(item.path);
      return { ...base, detail: basename(path) || title, args: path || null };
    }
    case "fileChange": {
      const base = plain("edit", "Edit");
      if (!content) return base;
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((change) => text(record(change).path)).filter(Boolean);
      return {
        ...base,
        detail: clip(paths.map(basename).join(", ")) || title,
        args: paths.length > 0 ? scrub(JSON.stringify(paths), MAX_ARGS) : null,
      };
    }
    case "search": {
      const base = plain("search", "Search");
      if (!content) return base;
      const query = text(item.query);
      return { ...base, detail: clip(query || title), args: query || null };
    }
    case "webSearch": {
      const base = plain("web", "WebSearch");
      if (!content) return base;
      const query = text(item.query);
      return { ...base, detail: clip(query || title), args: query || null };
    }
    case "webFetch": {
      const base = plain("web", "WebFetch");
      if (!content) return base;
      const url = text(item.url);
      return { ...base, detail: clip(url || title), args: url || null };
    }
    case "contextCompaction":
      return plain("compaction", "Compaction");
    case "delegation": {
      const background = item.background === true;
      const base = { ...plain("subagent", "delegation"), name: SUBAGENT, agent: SUBAGENT, background };
      return content ? { ...base, detail: clip(text(item.label) || title) } : base;
    }
    case "backgroundTask": {
      const base = { ...plain("background", "Background"), background: true };
      if (!content) return base;
      return { ...base, detail: clip(text(item.description) || title) };
    }
    case "toolCall": {
      const tool = text(item.tool) || "tool";
      const args = record(item.arguments);
      if (SUBAGENT_TOOLS.has(tool)) {
        const background = args.run_in_background === true;
        const agent = agentKind(args.subagent_type);
        const base = { ...plain("subagent", tool), name: agent, agent, background };
        if (!content) return base;
        return {
          ...base,
          detail: clip(text(args.description) || title),
          args: scrub(stringify(item.arguments), MAX_ARGS) || null,
        };
      }
      const base = plain("tool", tool);
      if (!content) return base;
      return {
        ...base,
        detail: clip(title || text(item.server)),
        args: scrub(stringify(item.arguments), MAX_ARGS) || null,
      };
    }
    default: {
      // The static label a plugin or provider registered for this kind of row.
      const label = record(record(item.presentation).label);
      const base = plain("tool", text(item.type) || text(label.completed) || "tool");
      return content ? { ...base, detail: clip(title) } : base;
    }
  }
}

/** What an interaction asked of the user. Without content, only its kind. */
function describeInteraction(
  payload: Json,
  content: boolean,
): Pick<Span, "toolName" | "name" | "detail"> {
  const kind = text(payload.kind);
  if (kind === "user_question") {
    const [first] = Array.isArray(payload.questions) ? payload.questions.map(record) : [];
    return {
      toolName: "Question",
      name: "Question",
      detail: content ? clip(text(first?.prompt) || text(first?.shortLabel)) : "",
    };
  }
  const toolName =
    kind.includes("permission") || kind.includes("approval") ? "Approval" : "Waiting for user";
  return {
    toolName,
    name: content ? clip(text(payload.title)) || toolName : toolName,
    detail: content ? clip(kind.replace(/_/g, " ")) : "",
  };
}

function errorOf(item: Json): string | null {
  const error = item.error;
  const message = typeof error === "string" ? error : text(record(error).message);
  return message ? clip(message, MAX_ERROR) : null;
}

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

  constructor(options: TraceBuilderOptions) {
    this.content = options.content;
    this.indexOffset = options.indexOffset ?? 0;
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
   * those close as interrupted instead of growing with the clock.
   */
  snapshot(now?: number): Turn[] {
    const stale = now !== undefined && now - this.lastEventAt > STALE_MS;
    return [...this.turns.values()].map(({ spanIds, activityIds, lastAt, previousEnd, ...turn }) => {
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
        const requestId = text(data.requestId);
        if (!requestId) return;
        const input = Array.isArray(data.input) ? data.input : [];
        const parts = input.map((part) => text(record(part).text)).filter(Boolean);
        // bb prefixes messages from other threads and its own notices.
        const first = parts[0] ?? "";
        const prefix = THREAD_MESSAGE_PREFIX.exec(first);
        const system = prefix ? null : SYSTEM_MESSAGE_PREFIX.exec(first);
        const execution = record(data.execution);
        this.requests.set(requestId, {
          input: this.content ? scrub(parts.join("\n\n"), MAX_INPUT) : null,
          sender: text(data.senderThreadId) || prefix?.[1] || (system ? BB_SENDER : null),
          model: text(execution.model) || null,
          reasoningLevel: text(execution.reasoningLevel) || null,
          serviceTier: text(execution.serviceTier) || null,
          permissionMode: text(execution.permissionMode) || null,
          initiator: text(data.initiator) || null,
          source: text(data.source) || null,
          seq: event.seq,
          at: event.createdAt,
          matched: false,
        });
        return;
      }
      case "turn/started":
        if (turnId) this.startTurn(turnId, text(data.parentToolCallId), event);
        return;
      case "turn/input/accepted": {
        const turn = turnId ? this.turns.get(turnId) : undefined;
        const request = this.requests.get(text(data.clientRequestId));
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
        turn.status = itemStatus(data.status);
        turn.error = errorOf(data);
        if (this.activeTurn === turn.id) this.activeTurn = null;
        return;
      }
      case "item/started":
      case "item/completed":
      case "item/backgroundTask/progress":
      case "item/backgroundTask/completed":
        this.foldItem(turnId, record(data.item), event);
        return;
      case "system/interaction/lifecycle":
        this.foldInteraction(turnId, record(data.interaction), event);
        return;
      case "provider/error":
        this.addMarker(turnId, event, {
          toolName: "Provider error",
          errorType: "provider_error",
          error: [text(data.message), text(data.detail)].filter(Boolean).join(": "),
          status: "failed",
        });
        return;
      case "system/error":
        this.addMarker(turnId, event, {
          toolName: "bb error",
          errorType: "bb_error",
          error: text(data.message) || text(data.code),
          status: "failed",
        });
        return;
      case "system/thread/interrupted":
        this.addMarker(turnId, event, {
          toolName: "Stopped",
          errorType: "interrupted",
          error: text(data.reason),
          status: "interrupted",
        });
        return;
      case "provider/modelFallback": {
        const turn = this.turnFor(turnId);
        const model = text(data.fallbackModel);
        if (turn && model) {
          turn.fallback = { model, reason: text(data.reason) || null, at: event.createdAt };
        }
        return;
      }
      case "provider/rateLimits/updated": {
        const turn = this.turnFor(turnId);
        const status = text(record(data.rateLimits).status);
        if (turn && status) turn.rateLimitStatus = status;
        return;
      }
      case "thread/contextWindowUsage/updated": {
        const turn = this.turnFor(turnId);
        if (!turn) return;
        const usage = record(data.contextWindowUsage);
        const snapshot = record(usage.snapshot);
        const number = (...values: unknown[]) =>
          values.find((value): value is number => typeof value === "number") ?? null;
        const usedTokens = number(usage.usedTokens, snapshot.usedTokens);
        const windowTokens = number(usage.modelContextWindow, snapshot.contextWindowTokens);
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
    if (parentTurn) {
      this.rootTurn.set(turnId, parentTurn);
      this.turnParent.set(turnId, parentToolCallId);
      return;
    }
    if (this.turns.has(turnId)) return;
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
      error: clip(marker.error ?? "", MAX_ERROR) || null,
      start: event.createdAt,
      end: event.createdAt,
      endSeq: event.seq,
    });
  }

  /** Approvals, questions, and other forms that wait on the user. */
  private foldInteraction(turnId: string | undefined, interaction: Json, event: TraceEvent): void {
    const interactionId = text(interaction.id);
    if (!interactionId) return;
    const id = `interaction:${interactionId}`;
    const status = text(interaction.status);
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
      ...describeInteraction(record(interaction.payload), this.content),
      start: event.createdAt,
    });
  }

  private foldItem(turnId: string | undefined, item: Json, event: TraceEvent): void {
    const id = text(item.id);
    const type = text(item.type);
    if (!id || SKIPPED_ITEMS.has(type)) return;
    const parentToolCallId =
      text(item.parentToolCallId) || (turnId && this.turnParent.get(turnId)) || "";
    // Background tasks report completion outside any turn; find their turn
    // through the span itself or the tool call that started it.
    const root = turnId
      ? this.rootTurn.get(turnId)
      : (this.spanTurn.get(id) ?? this.spanTurn.get(parentToolCallId));
    const turn = root ? this.turns.get(root) : undefined;
    if (!turn) return;
    this.touch(turn, event.seq, event.createdAt);

    if (type in ACTIVITY_ITEMS) {
      this.foldActivity(turn, id, ACTIVITY_ITEMS[type], parentToolCallId, event);
      // Only the turn's own agent writes the replies the user reads.
      if (
        this.content &&
        type === "agentMessage" &&
        event.type === "item/completed" &&
        !parentToolCallId
      ) {
        const reply = text(item.text).trim();
        if (reply) turn.replies.push(scrubTail(reply, MAX_REPLY));
      }
      return;
    }
    if (type === "backgroundTask" && AGENT_TASK_TYPES.has(text(item.taskType))) {
      this.foldSubagentTask(parentToolCallId, item, event);
      return;
    }
    // Only completions of other background tasks matter; their progress does not.
    if (event.type === "item/backgroundTask/progress") return;

    const finished = event.type !== "item/started";
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
    this.addSpan(turn, span);
    if (finished) {
      this.noteCallEnd(span, event);
      this.finish(span, item, event);
    }
  }

  /** A subagent's tool call returned; its agent may still be working. */
  private noteCallEnd(span: Span, event: TraceEvent): void {
    if (span.kind !== "subagent" || span.callEnd !== null) return;
    span.callEnd = Math.max(event.createdAt, span.start);
  }

  private finish(span: Span, item: Json, event: TraceEvent): void {
    span.end = Math.max(event.createdAt, span.start);
    span.endSeq = event.seq;
    span.status = itemStatus(item.status);
    if (typeof item.exitCode === "number") span.exitCode = item.exitCode;
    if (span.status === "failed") span.errorType = "tool_error";
    else if (span.status === "interrupted") span.errorType = "interrupted";
    if (!this.content) return;
    // A tool's error text and output are tool output.
    span.error = errorOf(item) ?? span.error;
    const result = stringify(item.aggregatedOutput ?? item.result);
    if (result) span.result = scrub(result, MAX_RESULT);
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
    this.recordSubagentUsage(spanId, record(item.usage));
    const span = this.spans.get(spanId);
    if (!span) return;
    const status = itemStatus(item.status);
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
    if (status === "failed") span.errorType = "tool_error";
    else if (status === "interrupted") span.errorType = "interrupted";
  }

  private recordSubagentUsage(spanId: string, usage: Json): void {
    const tokens = usage.totalTokens;
    if (!spanId || typeof tokens !== "number") return;
    const span = this.spans.get(spanId);
    if (span) span.tokens = tokens;
    else this.pendingTokens.set(spanId, tokens);
  }
}
