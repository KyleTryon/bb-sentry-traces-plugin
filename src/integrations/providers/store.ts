/**
 * What trace providers reported, kept in plugin storage until the export
 * needs it:
 *
 * - `claim:<threadId>`: the provider trace a thread is in, and who said so;
 * - `snapshot:<provider>/<traceKey>`: the newest report of a trace, with its
 *   spans in `snapshot-part:<version>:<n>`, since one stored value holds at
 *   most 256 KB;
 * - `provider:<pluginId>`: when a provider last reported, for `status`.
 *
 * Writes to one key run one at a time. A snapshot's parts are written before
 * the head that names them and dropped only after it moved on, so a reader
 * never puts together parts of two versions.
 */
import { randomUUID } from "node:crypto";
import { queue } from "../../core/queue.js";
import type { AttributeValue } from "../../core/otlp.js";
import type { ProviderSpan, ProviderTrace } from "./schema.js";
import type { ProviderRecord, StoredClaim, TraceContext } from "./types.js";

/** The part of bb's plugin storage this uses. */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export const CLAIM_PREFIX = "claim:";
export const SNAPSHOT_PREFIX = "snapshot:";
export const PART_PREFIX = "snapshot-part:";
export const PROVIDER_PREFIX = "provider:";

/** A stored value may be 256 KB; a part of a snapshot stays well under that. */
const MAX_PART_BYTES = 192 * 1024;
/** A claim lands on every span of its thread, so it is kept small. */
export const MAX_CLAIM_BYTES = 64 * 1024;
/** A part no snapshot names, this old, is left from a write that stopped part way. */
const STRAY_PART_MS = 60 * 60_000;

/** A stored snapshot without its spans. */
export interface SnapshotHead {
  provider: string;
  traceKey: string;
  reportedAt: number;
  /** Names this version's parts, and when it was written. */
  version: string;
  parts: number;
  /** The provider said the trace no longer exists. */
  deleted: boolean;
  ended: boolean;
  pipeline: string | null;
  attributes: Record<string, AttributeValue>;
}

/** A snapshot too large to store. */
export class SnapshotTooLarge extends Error {}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const snapshotKey = (provider: string, traceKey: string) => `${SNAPSHOT_PREFIX}${provider}/${traceKey}`;
const partKey = (version: string, index: number) => `${PART_PREFIX}${version}:${index}`;

/** Spans in runs that each fit in one stored value. */
function partsOf(spans: readonly ProviderSpan[]): ProviderSpan[][] {
  const parts: ProviderSpan[][] = [];
  let current: ProviderSpan[] = [];
  let size = 2;
  for (const span of spans) {
    const one = bytes(span) + 1;
    if (one > MAX_PART_BYTES) throw new SnapshotTooLarge(`span ${span.key} is larger than 192 KB`);
    if (size + one > MAX_PART_BYTES && current.length > 0) {
      parts.push(current);
      current = [];
      size = 2;
    }
    current.push(span);
    size += one;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** When a version was written, from its name. */
function writtenAt(version: string): number {
  return parseInt(version.split("-")[0] ?? "", 36);
}

export class ProviderStore {
  /** Writes of one key, one at a time. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly kv: Kv,
    private readonly now: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------- claims

  /** Where a thread sits in a provider's trace, or null when no provider claimed it. */
  async claim(threadId: string): Promise<TraceContext | null> {
    return (await this.kv.get<StoredClaim>(CLAIM_PREFIX + threadId))?.context ?? null;
  }

  /**
   * Claims a thread for `provider`, or clears its claim with null. A thread
   * another provider claimed stays theirs until they clear it.
   */
  setClaim(threadId: string, provider: string, context: TraceContext | null): Promise<"ok" | "conflict" | "invalid"> {
    const key = CLAIM_PREFIX + threadId;
    return queue(this.locks, key, async () => {
      const held = await this.kv.get<StoredClaim>(key);
      if (held && held.context.provider !== provider) return "conflict";
      if (context === null) {
        if (held) await this.kv.delete(key);
        return "ok";
      }
      const claim: StoredClaim = { context, reportedAt: this.now() };
      if (bytes(claim) > MAX_CLAIM_BYTES) return "invalid";
      await this.kv.set(key, claim);
      return "ok";
    });
  }

  /** Drops a thread's claim, whoever made it: the thread is gone. */
  deleteClaim(threadId: string): Promise<void> {
    const key = CLAIM_PREFIX + threadId;
    return queue(this.locks, key, () => this.kv.delete(key));
  }

  /** Every claim, by thread id. */
  async claims(): Promise<Map<string, StoredClaim>> {
    const found = new Map<string, StoredClaim>();
    for (const key of await this.kv.list(CLAIM_PREFIX)) {
      const claim = await this.kv.get<StoredClaim>(key);
      if (claim) found.set(key.slice(CLAIM_PREFIX.length), claim);
    }
    return found;
  }

  // ----------------------------------------------------------------- snapshots

  /**
   * Stores a trace as reported, in place of the one before. Throws
   * `SnapshotTooLarge` when a span does not fit in one stored value.
   */
  saveSnapshot(provider: string, trace: ProviderTrace): Promise<void> {
    const parts = partsOf(trace.spans);
    return this.replace(provider, trace.key, async (version) => {
      for (const [index, spans] of parts.entries()) await this.kv.set(partKey(version, index), spans);
      return {
        provider,
        traceKey: trace.key,
        reportedAt: this.now(),
        version,
        parts: parts.length,
        deleted: false,
        ended: trace.ended,
        pipeline: trace.pipeline ?? null,
        attributes: (trace.attributes ?? {}) as Record<string, AttributeValue>,
      };
    });
  }

  /** Remembers that a provider no longer has a trace, so its root can be sent as deleted. */
  saveDeleted(provider: string, traceKey: string): Promise<void> {
    return this.replace(provider, traceKey, async (version) => ({
      provider,
      traceKey,
      reportedAt: this.now(),
      version,
      parts: 0,
      deleted: true,
      ended: true,
      pipeline: null,
      attributes: {},
    }));
  }

  /** Writes a new version's parts and head, then drops the old version's parts. */
  private replace(provider: string, traceKey: string, write: (version: string) => Promise<SnapshotHead>): Promise<void> {
    const key = snapshotKey(provider, traceKey);
    return queue(this.locks, key, async () => {
      const version = `${this.now().toString(36)}-${randomUUID().slice(0, 8)}`;
      const head = await write(version);
      const old = await this.kv.get<SnapshotHead>(key);
      await this.kv.set(key, head);
      if (old) await this.dropParts(old);
    });
  }

  private async dropParts(head: SnapshotHead): Promise<void> {
    for (let index = 0; index < head.parts; index++) await this.kv.delete(partKey(head.version, index));
  }

  /** Drops a stored snapshot and its parts. */
  deleteSnapshot(provider: string, traceKey: string): Promise<void> {
    const key = snapshotKey(provider, traceKey);
    return queue(this.locks, key, async () => {
      const head = await this.kv.get<SnapshotHead>(key);
      if (!head) return;
      await this.kv.delete(key);
      await this.dropParts(head);
    });
  }

  /** A snapshot's head, without reading its spans. */
  head(provider: string, traceKey: string): Promise<SnapshotHead | undefined> {
    return this.kv.get<SnapshotHead>(snapshotKey(provider, traceKey));
  }

  /**
   * The trace as last reported: `null` when its provider said it no longer
   * exists, `undefined` when nothing was reported or a newer report is being
   * written over it.
   */
  async snapshot(
    provider: string,
    traceKey: string,
    known?: SnapshotHead,
  ): Promise<ProviderTrace | null | undefined> {
    const head = known ?? (await this.head(provider, traceKey));
    if (!head) return undefined;
    if (head.deleted) return null;
    const spans: ProviderSpan[] = [];
    for (let index = 0; index < head.parts; index++) {
      const part = await this.kv.get<ProviderSpan[]>(partKey(head.version, index));
      if (!part) return undefined;
      spans.push(...part);
    }
    return { key: head.traceKey, ended: head.ended, pipeline: head.pipeline, attributes: head.attributes, spans };
  }

  /** Every stored snapshot's head. */
  async heads(): Promise<SnapshotHead[]> {
    const found: SnapshotHead[] = [];
    for (const key of await this.kv.list(SNAPSHOT_PREFIX)) {
      const head = await this.kv.get<SnapshotHead>(key);
      if (head) found.push(head);
    }
    return found;
  }

  /** Drops parts no snapshot names, left from writes that stopped part way. */
  async dropStrayParts(): Promise<void> {
    const named = new Set((await this.heads()).map((head) => head.version));
    for (const key of await this.kv.list(PART_PREFIX)) {
      const version = key.slice(PART_PREFIX.length, key.lastIndexOf(":"));
      if (named.has(version) || this.now() - writtenAt(version) < STRAY_PART_MS) continue;
      await this.kv.delete(key);
    }
  }

  // ----------------------------------------------------------------- providers

  /** Notes that a provider just reported. */
  noteReport(provider: string): Promise<void> {
    return this.kv.set(PROVIDER_PREFIX + provider, { lastReportAt: this.now() } satisfies ProviderRecord);
  }

  /** When each provider last reported, by plugin id. */
  async reporters(): Promise<Map<string, ProviderRecord>> {
    const found = new Map<string, ProviderRecord>();
    for (const key of await this.kv.list(PROVIDER_PREFIX)) {
      const record = await this.kv.get<ProviderRecord>(key);
      if (record) found.set(key.slice(PROVIDER_PREFIX.length), record);
    }
    return found;
  }

  forgetReporter(provider: string): Promise<void> {
    return this.kv.delete(PROVIDER_PREFIX + provider);
  }
}
