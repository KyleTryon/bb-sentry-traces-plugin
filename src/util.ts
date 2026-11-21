/**
 * Small helpers for reading untyped event data.
 *
 * Adapted from bb-plugin-agent-traces (https://github.com/charpeni/bb-plugins,
 * plugins/agent-traces/util.ts), MIT License, Copyright (c) 2026 Nicolas
 * Charpentier. See THIRD_PARTY_NOTICES.md.
 */

export type Json = Record<string, unknown>;

export function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One line of at most `max` characters, ending in "…" when cut. */
export function oneLine(value: string, max = 90): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** At most `max` characters, with a visible marker when cut. Keeps line breaks. */
export function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  const marker = `\n[… ${value.length - max} more characters cut]`;
  return `${value.slice(0, Math.max(0, max))}${marker}`;
}

/** The last `max` characters, with a visible marker when cut. */
export function capTail(value: string, max: number): string {
  if (value.length <= max) return value;
  return `[… ${value.length - max} earlier characters cut]\n${value.slice(-max)}`;
}

/** What the exporter needs to know about a thread, beside its events. */
export interface ThreadInfo {
  id: string;
  title: string | null;
  projectId: string | null;
  providerId: string | null;
  parentThreadId: string | null;
  /** The thread whose life this one is tied to, such as a workflow's origin thread. */
  lifecycleOwnerThreadId: string | null;
  /** How the thread came to be: by the user, a plugin, a fork, and so on. */
  originKind: string | null;
  originPluginId: string | null;
  visibility: string | null;
  environmentId: string | null;
  hostId: string | null;
  isWorktree: boolean | null;
  /** bb names branches after the thread's title, so this is content. */
  branch: string | null;
}

/** Reads a bb thread, as an event or the SDK gives it, into what the exporter keeps. */
export function toThreadInfo(thread: { id: string } & Json): ThreadInfo {
  const optional = (value: unknown) => text(value) || null;
  return {
    id: thread.id,
    title: optional(thread.title),
    projectId: optional(thread.projectId),
    providerId: optional(thread.providerId),
    parentThreadId: optional(thread.parentThreadId),
    lifecycleOwnerThreadId: optional(thread.lifecycleOwnerThreadId),
    originKind: optional(thread.originKind),
    originPluginId: optional(thread.originPluginId),
    visibility: optional(thread.visibility),
    environmentId: optional(thread.environmentId),
    hostId: optional(thread.environmentHostId),
    isWorktree: typeof thread.environmentIsWorktree === "boolean" ? thread.environmentIsWorktree : null,
    branch: optional(thread.environmentBranchName),
  };
}
