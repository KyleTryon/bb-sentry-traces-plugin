import type { OtlpSpan, OtlpTraces } from "../src/core/otlp.js";
import type { TraceEvent } from "../src/core/trace/types.js";

/** Text that must never leave the machine while content capture is off. */
export const SECRETS = {
  prompt: "PROMPT-TEXT-zebra",
  reply: "REPLY-TEXT-walrus",
  command: "deploy-acme-prod.sh --token COMMAND-TEXT-otter",
  output: "OUTPUT-TEXT-heron",
  path: "/home/me/PATH-TEXT-lynx/secret-plan.md",
  toolArg: "ARG-TEXT-ibis",
  toolResult: "RESULT-TEXT-newt",
  label: "LABEL-TEXT-quail",
  title: "TITLE-TEXT-marmot",
  toolError: "TOOLERR-TEXT-gecko",
  branch: "BRANCH-TEXT-osprey",
  workflowLabel: "WFLABEL TEXT puffin",
  phaseTitle: "PHASE TEXT tapir",
  rationale: "RATIONALE-TEXT-civet",
} as const;

/** Builds a thread's event history with increasing sequence numbers and times. */
export class History {
  readonly events: TraceEvent[] = [];
  private seq = 0;
  private at: number;
  private turns = 0;

  constructor(start = 1_800_000_000_000) {
    this.at = start;
  }

  get now(): number {
    return this.at;
  }

  wait(ms: number): this {
    this.at += ms;
    return this;
  }

  push(type: string, data: unknown, turnId?: string): TraceEvent {
    const event: TraceEvent = {
      seq: ++this.seq,
      createdAt: this.at,
      type,
      scope: turnId ? { kind: "turn", turnId } : { kind: "thread" },
      data,
    };
    this.events.push(event);
    this.at += 10;
    return event;
  }

  request(requestId: string, prompt: string = SECRETS.prompt, model = "claude-fable-5-2"): this {
    this.push("client/turn/requested", {
      requestId,
      senderThreadId: null,
      initiator: "user",
      source: "spawn",
      input: [{ type: "text", text: prompt, mentions: [] }],
      execution: { model, reasoningLevel: "high", serviceTier: "default", permissionMode: "auto" },
    });
    return this;
  }

  start(turnId: string, requestId?: string): this {
    this.push("turn/started", { providerThreadId: "p" }, turnId);
    if (requestId) {
      this.push("turn/input/accepted", { clientRequestId: requestId }, turnId);
    }
    return this;
  }

  item(turnId: string, item: Record<string, unknown>, ms = 500, done?: Record<string, unknown>): this {
    this.push("item/started", { item: { ...item, status: "pending" } }, turnId);
    this.wait(ms);
    this.push("item/completed", { item: { ...item, status: "completed", ...done } }, turnId);
    return this;
  }

  complete(turnId: string, status = "completed", error?: string): this {
    this.push(
      "turn/completed",
      { status, ...(error ? { error: { message: error } } : {}) },
      turnId,
    );
    return this;
  }

  /** One ordinary turn: thinking, a command, a tool call, a file read, and a reply. */
  turn(options: { status?: string; model?: string } = {}): string {
    const n = ++this.turns;
    const turnId = `turn-${n}`;
    const requestId = `req-${n}`;
    this.request(requestId, SECRETS.prompt, options.model);
    this.wait(50);
    this.start(turnId, requestId);
    this.item(turnId, { type: "reasoning", id: `${turnId}-r1`, summary: [], content: [] }, 800);
    this.item(
      turnId,
      {
        type: "commandExecution",
        id: `${turnId}-c1`,
        command: SECRETS.command,
        presentation: { title: SECRETS.command },
      },
      1_200,
      { exitCode: 0, aggregatedOutput: SECRETS.output },
    );
    this.wait(300);
    this.item(
      turnId,
      {
        type: "toolCall",
        id: `${turnId}-t1`,
        tool: "mcp__docs__search",
        arguments: { query: SECRETS.toolArg },
        presentation: { title: SECRETS.toolArg },
      },
      400,
      { result: SECRETS.toolResult },
    );
    this.item(
      turnId,
      { type: "fileRead", id: `${turnId}-f1`, path: SECRETS.path, presentation: { title: "secret-plan.md" } },
      100,
    );
    this.item(turnId, { type: "agentMessage", id: `${turnId}-m1`, text: SECRETS.reply }, 600);
    this.complete(turnId, options.status ?? "completed");
    return turnId;
  }

  usage(total: Record<string, number>): this {
    // bb keeps only the latest usage event per thread.
    const index = this.events.findIndex((event) => event.type === "thread/tokenUsage/updated");
    if (index !== -1) this.events.splice(index, 1);
    this.push("thread/tokenUsage/updated", { tokenUsage: { total, last: total } });
    return this;
  }

  /** A running cost, as ACP agents that report no tokens put on the context window event. */
  cost(amount: number, currency = "USD"): this {
    this.push("thread/contextWindowUsage/updated", {
      contextWindowUsage: { usedTokens: 1_000, modelContextWindow: 200_000, cost: { amount, currency } },
    });
    return this;
  }
}

type ListArgs = {
  threadId: string;
  afterSeq?: string;
  limit?: string;
  order?: "asc" | "desc";
  types?: readonly string[];
};

/** `bb.sdk.threads.events.list` over in-memory histories, with the same paging. */
export function eventsList(histories: Record<string, History>) {
  return async ({ threadId, afterSeq, limit, order, types }: ListArgs) => {
    const after = Number(afterSeq ?? 0);
    const rows = (histories[threadId]?.events ?? [])
      .filter((event) => event.seq > after && (!types || types.includes(event.type)))
      .map((event) => ({ ...event, id: `evt-${event.seq}`, threadId }));
    if (order === "desc") rows.reverse();
    return rows.slice(0, Number(limit ?? 100));
  };
}

export function attr(span: OtlpSpan, key: string): string | number | boolean | undefined {
  const value = span.attributes.find((attribute) => attribute.key === key)?.value;
  if (!value) return undefined;
  if ("stringValue" in value) return value.stringValue;
  if ("intValue" in value) return Number(value.intValue);
  if ("doubleValue" in value) return value.doubleValue;
  return value.boolValue;
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: OtlpTraces;
  spans: OtlpSpan[];
}

/** A `fetch` that records what was posted and answers with `status`. */
export function fakeFetch(respond: () => number | Error = () => 200) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const answer = respond();
    if (answer instanceof Error) throw answer;
    const body = JSON.parse(init?.body as string) as OtlpTraces;
    if (answer >= 200 && answer < 300) {
      sent.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
        body,
        spans: body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
      });
    }
    return new Response(answer === 200 ? "{}" : "nope", { status: answer });
  }) as typeof fetch;
  return { fetchImpl, sent, spans: () => sent.flatMap((request) => request.spans) };
}

export const DSN = "https://0123456789abcdef0123456789abcdef@o42.ingest.us.sentry.io/4500000000000001";
