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
 * never puts together parts of two versions; one that finds a part gone reads
 * the newer version instead.
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

const CLAIM_PREFIX = "claim:";
const SNAPSHOT_PREFIX = "snapshot:";
const PART_PREFIX = "snapshot-part:";
const PROVIDER_PREFIX = "provider:";

/** A stored value may be 256 KB; a part of a snapshot stays well under that. */
const MAX_PART_BYTES = 192 * 1024;
/**
 * One span, without its content and error text, which are capped on their
 * own: past this it is refused, the same whether content is captured or not,
 * and with them it still fits in one part.
 */
const MAX_SPAN_BYTES = 128 * 1024;
/** A snapshot's head: its pipeline and attributes, which every span carries. */
const MAX_HEAD_BYTES = 192 * 1024;
/** A claim lands on every span of its thread, so it is kept small. */
const MAX_CLAIM_BYTES = 64 * 1024;
/** A part no snapshot names, this old, is left from a write that stopped part way. */
const STRAY_PART_MS = 60 * 60_000;
/** How many times a read starts over when the version it was reading is replaced under it. */
const READ_ATTEMPTS = 3;
/** Threads one provider may claim. Past this a new claim gets `limit`. */
const MAX_CLAIMS_PER_PROVIDER = 5_000;
/** Snapshots a provider may have stored that no export needs; the oldest go first. */
const MAX_UNTRACKED_SNAPSHOTS = 200;

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
    if (bytes({ ...span, content: null, errorMessage: null }) > MAX_SPAN_BYTES) {
      throw new SnapshotTooLarge(`span ${span.key} is larger than 128 KB without its content`);
    }
    const one = bytes(span) + 1;
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

function count(counts: Map<string, number>, provider: string, by: number): void {
  counts.set(provider, (counts.get(provider) ?? 0) + by);
}

export class ProviderStore {
  /** Writes of one key, one at a time. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** How many threads each provider claims: counted from storage once, then kept up to date. */
  private claimCounts: Promise<Map<string, number>> | undefined;

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
   * another provider claimed stays theirs until they clear it, and a provider
   * past `MAX_CLAIMS_PER_PROVIDER` claims no new thread.
   */
  setClaim(
    threadId: string,
    provider: string,
    context: TraceContext | null,
  ): Promise<"ok" | "conflict" | "invalid" | "limit"> {
    const key = CLAIM_PREFIX + threadId;
    return queue(this.locks, key, async () => {
      const counts = await this.counts();
      const held = await this.kv.get<StoredClaim>(key);
      if (held && held.context.provider !== provider) return "conflict";
      if (context === null) {
        if (held) {
          await this.kv.delete(key);
          count(counts, provider, -1);
        }
        return "ok";
      }
      const claim: StoredClaim = { context, reportedAt: this.now() };
      if (bytes(claim) > MAX_CLAIM_BYTES) return "invalid";
      if (held) {
        await this.kv.set(key, claim);
        return "ok";
      }
      if ((counts.get(provider) ?? 0) >= MAX_CLAIMS_PER_PROVIDER) return "limit";
      // Counted before the write, so claims of other threads made meanwhile cannot pass the cap together.
      count(counts, provider, 1);
      try {
        await this.kv.set(key, claim);
      } catch (cause) {
        count(counts, provider, -1);
        throw cause;
      }
      return "ok";
    });
  }

  /**
   * Drops a thread's claim, whoever made it: the thread is gone. With
   * `reportedAt`, only the claim made then, so a claim made again since stays.
   */
  deleteClaim(threadId: string, reportedAt?: number): Promise<void> {
    const key = CLAIM_PREFIX + threadId;
    return queue(this.locks, key, async () => {
      const counts = await this.counts();
      const held = await this.kv.get<StoredClaim>(key);
      if (!held || (reportedAt !== undefined && held.reportedAt !== reportedAt)) return;
      await this.kv.delete(key);
      count(counts, held.context.provider, -1);
    });
  }

  private counts(): Promise<Map<string, number>> {
    this.claimCounts ??= this.countClaims().catch((cause: unknown) => {
      this.claimCounts = undefined;
      throw cause;
    });
    return this.claimCounts;
  }

  private async countClaims(): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    for (const claim of (await this.claims()).values()) count(counts, claim.context.provider, 1);
    return counts;
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
   * `SnapshotTooLarge` when a span or the head does not fit in one stored
   * value, before anything is written.
   */
  async saveSnapshot(provider: string, trace: ProviderTrace): Promise<void> {
    const parts = partsOf(trace.spans);
    const fields = {
      provider,
      traceKey: trace.key,
      deleted: false,
      ended: trace.ended,
      pipeline: trace.pipeline ?? null,
      attributes: (trace.attributes ?? {}) as Record<string, AttributeValue>,
    };
    // With room for the fields added below, which are short.
    if (bytes(fields) + 256 > MAX_HEAD_BYTES) {
      throw new SnapshotTooLarge("the trace's pipeline and attributes are larger than 192 KB");
    }
    await this.replace(provider, trace.key, async (version) => {
      for (const [index, spans] of parts.entries()) await this.kv.set(partKey(version, index), spans);
      return { ...fields, reportedAt: this.now(), version, parts: parts.length };
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

  /**
   * Drops a stored snapshot and its parts. With `version`, only that version:
   * a newer report, which came in after the caller decided, stays.
   */
  deleteSnapshot(provider: string, traceKey: string, version?: string): Promise<void> {
    const key = snapshotKey(provider, traceKey);
    return queue(this.locks, key, async () => {
      const head = await this.kv.get<SnapshotHead>(key);
      if (!head || (version !== undefined && head.version !== version)) return;
      await this.kv.delete(key);
      await this.dropParts(head);
    });
  }

  /**
   * Keeps at most `MAX_UNTRACKED_SNAPSHOTS` of a provider's snapshots that
   * no export needs, as `tracked` tells, dropping the oldest reported.
   */
  async trimSnapshots(provider: string, tracked: (traceKey: string) => Promise<boolean>): Promise<void> {
    const keys = await this.kv.list(`${SNAPSHOT_PREFIX}${provider}/`);
    if (keys.length <= MAX_UNTRACKED_SNAPSHOTS) return;
    const untracked: SnapshotHead[] = [];
    for (const key of keys) {
      const head = await this.kv.get<SnapshotHead>(key);
      if (head && !(await tracked(head.traceKey))) untracked.push(head);
    }
    untracked.sort((a, b) => a.reportedAt - b.reportedAt);
    for (const head of untracked.slice(0, Math.max(0, untracked.length - MAX_UNTRACKED_SNAPSHOTS))) {
      await this.deleteSnapshot(provider, head.traceKey, head.version);
    }
  }

  /** A snapshot's head, without reading its spans. */
  head(provider: string, traceKey: string): Promise<SnapshotHead | undefined> {
    return this.kv.get<SnapshotHead>(snapshotKey(provider, traceKey));
  }

  /**
   * The trace as last reported: `null` when its provider said it no longer
   * exists, `undefined` when nothing was reported.
   */
  async snapshot(provider: string, traceKey: string): Promise<ProviderTrace | null | undefined> {
    const read = await this.read(provider, traceKey);
    return read === undefined ? undefined : read.trace;
  }

  /**
   * The trace as last reported, from `known` when given, and the head it was
   * read from. A version replaced while it is read has its parts dropped: the
   * newer one is read instead, a few times at most, and only a snapshot that
   * is gone, or keeps changing, reads as none.
   */
  async read(
    provider: string,
    traceKey: string,
    known?: SnapshotHead,
  ): Promise<{ head: SnapshotHead; trace: ProviderTrace | null } | undefined> {
    let head = known ?? (await this.head(provider, traceKey));
    for (let attempt = 1; head && attempt <= READ_ATTEMPTS; attempt++) {
      if (head.deleted) return { head, trace: null };
      const spans = await this.spansOf(head);
      if (spans) {
        const { ended, pipeline, attributes } = head;
        return { head, trace: { key: head.traceKey, ended, pipeline, attributes, spans } };
      }
      head = await this.head(provider, traceKey);
    }
    return undefined;
  }

  /** A version's spans, or undefined when a part of it is gone. */
  private async spansOf(head: SnapshotHead): Promise<ProviderSpan[] | undefined> {
    const spans: ProviderSpan[] = [];
    for (let index = 0; index < head.parts; index++) {
      const part = await this.kv.get<ProviderSpan[]>(partKey(head.version, index));
      if (!part) return undefined;
      spans.push(...part);
    }
    return spans;
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
