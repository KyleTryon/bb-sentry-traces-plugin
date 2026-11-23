/**
 * Names what an event row is about: a call, an interaction, an error. This is
 * where the trace decides what it keeps of a row, so most of the rules for
 * what is kept without content live here: with `content` off, every name is
 * fixed text, a plain identifier, or an error code.
 *
 * Adapted from bb-plugin-agent-traces (https://github.com/charpeni/bb-plugins,
 * plugins/agent-traces/trace.ts), MIT License, Copyright (c) 2026 Nicolas
 * Charpentier. See THIRD_PARTY_NOTICES.md; the changes are listed in
 * `builder.ts`.
 */
import { basename, programOf, unwrapCommand } from "./shell.js";
import { MAX_ARGS, MAX_ERROR, type Span, type SpanKind } from "./types.js";
import { scrub, scrubLine } from "../scrub/cut.js";
import { scrubValue } from "../scrub/value.js";
import { errorCode, record, text, toolName, type Json } from "../text.js";

const MAX_TEXT = 160;
/**
 * Tool calls that hand work to another agent even when nothing in the thread
 * points back at them: Claude Code's older `Agent` and `Task`, Antigravity's
 * `invoke_subagent` (whose agents run out of sight) and Grok's
 * `spawn_subagent`. Any other call becomes a subagent by what points at it.
 */
const SUBAGENT_TOOLS = new Set(["Agent", "Task", "invoke_subagent", "spawn_subagent"]);
/**
 * OpenCode's subagent tool. `task` is a common enough name that only its
 * `subagent_type` argument says the call hands off.
 */
const LOWERCASE_TASK_TOOL = "task";
/** Arguments that name the kind of agent a call hands work to, by provider. */
const AGENT_KIND_KEYS = [
  "subagent_type",
  "subagentType",
  "agent_type",
  "agentType",
  "TypeName",
  "agent",
  // A forked Skill runs as an agent named after its skill.
  "skill",
] as const;

/**
 * One line of text, scrubbed before it is cut so a cut cannot hide a secret's
 * shape. All kept text is scrubbed here, where a structured value can still
 * be scrubbed string by string.
 */
function clip(value: string, max = MAX_TEXT): string {
  return scrubLine(value, max);
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

/** The tool name of a handoff bb records as a `delegation` row rather than a tool call. */
const HANDOFF_TOOL = "Agent";

/**
 * A subagent's kind, when it is a plain identifier. It becomes an agent name
 * in Sentry, which has to be one of a small set, so free text, paths and
 * anything with spaces are refused.
 */
function agentKind(value: unknown): string | null {
  const kind = text(value).trim();
  return /^[\w.:@-]{1,64}$/.test(kind) ? kind : null;
}

/** The first plain kind among the arguments that name one. */
export function agentKindIn(args: Json): string | null {
  for (const key of AGENT_KIND_KEYS) {
    const kind = agentKind(args[key]);
    if (kind) return kind;
  }
  return null;
}

/**
 * A `delegation` row's kind. bb does not record it as a field; its providers
 * put it in the row's detail line instead: Claude Code as
 * `general-purpose agent · model …`, Grok as the bare kind. Only a plain
 * identifier survives, so the line's other parts cannot leak through.
 */
function delegationKind(item: Json): string | null {
  const own = agentKindIn(item);
  if (own) return own;
  const detail = text(record(item['presentation'])['detail']);
  const [first = ""] = detail.split(" · ");
  return agentKind(first.replace(/\s+agent$/, ""));
}

/** A tool call that hands work to another agent by its name alone. */
function isSubagentTool(tool: string, args: Json): boolean {
  if (SUBAGENT_TOOLS.has(tool)) return true;
  return tool === LOWERCASE_TASK_TOOL && agentKind(args['subagent_type']) !== null;
}

/**
 * A tool's name as kept. A plain identifier stays as it is; anything else,
 * such as a name with a path or spaces in it, is kept only with content, and
 * is `fallback` without.
 */
function nameOfTool(value: string, content: boolean, fallback: string): string {
  const name = toolName(value);
  if (name) return name;
  return content && value.trim() ? clip(value) : fallback;
}

/**
 * Names a call. With `content` off, every field is fixed text or the tool's
 * own name: nothing the user or the model wrote.
 */
export function describe(item: Json, content: boolean): Description {
  const title = content ? text(record(item['presentation'])['title']) : "";
  const plain = (kind: SpanKind, toolName: string): Description => ({
    kind,
    toolName,
    name: toolName,
    detail: "",
    background: false,
    args: null,
    agent: null,
  });
  switch (item['type']) {
    case "commandExecution": {
      const base = plain("command", "shell");
      if (!content) return base;
      const command = unwrapCommand(item['command']);
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
      const path = text(item['path']);
      return { ...base, detail: basename(path) || title, args: scrub(path, MAX_ARGS) || null };
    }
    case "fileChange": {
      const base = plain("edit", "Edit");
      if (!content) return base;
      const changes = Array.isArray(item['changes']) ? item['changes'] : [];
      const paths = changes.map((change) => text(record(change)['path'])).filter(Boolean);
      return {
        ...base,
        detail: clip(paths.map(basename).join(", ")) || title,
        args: paths.length > 0 ? scrubValue(paths, MAX_ARGS) : null,
      };
    }
    case "search": {
      const base = plain("search", "Search");
      if (!content) return base;
      const query = text(item['query']);
      return { ...base, detail: clip(query || title), args: scrub(query, MAX_ARGS) || null };
    }
    case "webSearch": {
      const base = plain("web", "WebSearch");
      if (!content) return base;
      const query = text(item['query']);
      return { ...base, detail: clip(query || title), args: scrub(query, MAX_ARGS) || null };
    }
    case "webFetch": {
      const base = plain("web", "WebFetch");
      if (!content) return base;
      const url = text(item['url']);
      return { ...base, detail: clip(url || title), args: scrub(url, MAX_ARGS) || null };
    }
    case "contextCompaction":
      return plain("compaction", "Compaction");
    case "delegation": {
      const background = item['background'] === true;
      const agent = delegationKind(item) ?? SUBAGENT;
      const base = { ...plain("subagent", HANDOFF_TOOL), name: agent, agent, background };
      return content ? { ...base, detail: clip(text(item['label']) || title) } : base;
    }
    case "backgroundTask": {
      const base = { ...plain("background", "Background"), background: true };
      if (!content) return base;
      return { ...base, detail: clip(text(item['description']) || title) };
    }
    case "toolCall": {
      const tool = nameOfTool(text(item['tool']), content, "tool");
      const args = record(item['arguments']);
      if (isSubagentTool(tool, args)) {
        const background = args['run_in_background'] === true;
        const agent = agentKindIn(args) ?? SUBAGENT;
        const base = { ...plain("subagent", tool), name: agent, agent, background };
        if (!content) return base;
        return {
          ...base,
          detail: clip(text(args['description']) || title),
          args: scrubValue(item['arguments'], MAX_ARGS) || null,
        };
      }
      const base = plain("tool", tool);
      if (!content) return base;
      return {
        ...base,
        detail: clip(title || text(item['server'])),
        args: scrubValue(item['arguments'], MAX_ARGS) || null,
      };
    }
    default: {
      // The static label a plugin or provider registered for this kind of row.
      const label = record(record(item['presentation'])['label']);
      const kind = text(item['type']) || text(label['completed']);
      const base = plain("tool", nameOfTool(kind, content, "tool"));
      return content ? { ...base, detail: clip(title) } : base;
    }
  }
}

/** What an interaction asked of the user. Without content, only its kind. */
export function describeInteraction(
  payload: Json,
  content: boolean,
): Pick<Span, "toolName" | "name" | "detail"> {
  const kind = text(payload['kind']);
  if (kind === "user_question") {
    const [first] = Array.isArray(payload['questions']) ? payload['questions'].map(record) : [];
    return {
      toolName: "Question",
      name: "Question",
      detail: content ? clip(text(first?.['prompt']) || text(first?.['shortLabel'])) : "",
    };
  }
  const toolName =
    kind.includes("permission") || kind.includes("approval") ? "Approval" : "Waiting for user";
  return {
    toolName,
    name: content ? clip(text(payload['title'])) || toolName : toolName,
    detail: content ? clip(kind.replace(/_/g, " ")) : "",
  };
}

export function errorMessageOf(item: Json): string {
  const error = item['error'];
  return typeof error === "string" ? error : text(record(error)['message']);
}

export function errorOf(item: Json): string | null {
  const message = errorMessageOf(item);
  return message ? clip(message, MAX_ERROR) : null;
}

/**
 * Error text from a provider or from bb, as kept. With content, `full`,
 * scrubbed and cut. Without, the first of `parts` that reads as a code, such
 * as `overloaded_error` or `ENOENT`: any other may hold a path, a command line
 * or a credential.
 */
export function errorText(full: string, parts: readonly string[], content: boolean): string | null {
  if (content) return clip(full, MAX_ERROR) || null;
  for (const part of parts) {
    const code = errorCode(part);
    if (code) return code;
  }
  return null;
}
