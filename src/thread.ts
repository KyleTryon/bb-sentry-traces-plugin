import { type Json, text } from "./core/text.js";

/** What the exporter reads from a bb thread, beside its events. */
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
    title: optional(thread['title']),
    projectId: optional(thread['projectId']),
    providerId: optional(thread['providerId']),
    parentThreadId: optional(thread['parentThreadId']),
    lifecycleOwnerThreadId: optional(thread['lifecycleOwnerThreadId']),
    originKind: optional(thread['originKind']),
    originPluginId: optional(thread['originPluginId']),
    visibility: optional(thread['visibility']),
    environmentId: optional(thread['environmentId']),
    hostId: optional(thread['environmentHostId']),
    isWorktree: typeof thread['environmentIsWorktree'] === "boolean" ? thread['environmentIsWorktree'] : null,
    branch: optional(thread['environmentBranchName']),
  };
}
