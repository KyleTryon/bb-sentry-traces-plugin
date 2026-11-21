/**
 * The synthetic trace `bb sentry-traces test` sends: fixed text and fixed
 * shape, under a new trace id each time, so it can be told apart from real runs.
 */
import { span as otlpSpan, spanIdFor, traceIdFor, type OtlpSpan } from "./core/otlp.js";

/** One synthetic agent run: no thread data, fixed text, a new trace each time. */
export function syntheticSpans(now: number, nonce: string): { traceId: string; spans: OtlpSpan[] } {
  const traceId = traceIdFor(`test/${nonce}`);
  const id = (key: string) => spanIdFor(`test/${nonce}/${key}`);
  const conversation = `bb-sentry-traces-test-${nonce}`;
  const model = "claude-sonnet-4-5";
  const shared = {
    "gen_ai.conversation.id": conversation,
    "gen_ai.agent.name": "bb-sentry-traces-test",
    "gen_ai.provider.name": "anthropic",
    "bb.synthetic": true,
  };
  const start = now - 3_000;
  const input = JSON.stringify([
    { role: "user", parts: [{ type: "text", content: "Synthetic test prompt from bb sentry-traces." }] },
  ]);
  const output = JSON.stringify([
    { role: "assistant", parts: [{ type: "text", content: "Synthetic test reply." }] },
  ]);
  const chat = (key: string, from: number, to: number, last: boolean) =>
    otlpSpan({
      traceId,
      spanId: id(key),
      parentSpanId: id("turn"),
      name: `chat ${model}`,
      client: true,
      start: from,
      end: to,
      attributes: {
        ...shared,
        "sentry.op": "gen_ai.chat",
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": model,
        "bb.inferred": true,
        ...(last
          ? {
              "gen_ai.usage.input_tokens": 1_200,
              "gen_ai.usage.cache_read.input_tokens": 1_000,
              "gen_ai.usage.output_tokens": 80,
              "gen_ai.usage.total_tokens": 1_280,
              "gen_ai.input.messages": input,
              "gen_ai.output.messages": output,
            }
          : {}),
      },
    });
  return {
    traceId,
    spans: [
      otlpSpan({
        traceId,
        spanId: id("turn"),
        name: "invoke_agent bb-sentry-traces-test",
        start,
        end: now,
        attributes: {
          ...shared,
          "sentry.op": "gen_ai.invoke_agent",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.request.model": model,
          "gen_ai.input.messages": input,
          "gen_ai.output.messages": output,
        },
      }),
      chat("chat:0", start, start + 1_000, false),
      otlpSpan({
        traceId,
        spanId: id("tool"),
        parentSpanId: id("turn"),
        name: "execute_tool shell",
        start: start + 1_000,
        end: start + 2_000,
        attributes: {
          ...shared,
          "sentry.op": "gen_ai.execute_tool",
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "shell",
          "gen_ai.tool.call.id": `test-${nonce}`,
          "process.exit.code": 0,
        },
      }),
      // A handoff: the tool call is its record, and the target agent's run nests under it.
      otlpSpan({
        traceId,
        spanId: id("handoff"),
        parentSpanId: id("turn"),
        name: "execute_tool Agent",
        start: start + 2_000,
        end: start + 2_500,
        attributes: {
          ...shared,
          "sentry.op": "gen_ai.execute_tool",
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": "Agent",
          "gen_ai.tool.call.id": `test-${nonce}-handoff`,
          "gen_ai.transfer.target.name": "bb-sentry-traces-test-helper",
          "gen_ai.transfer.mode": "return_to_caller",
        },
      }),
      otlpSpan({
        traceId,
        spanId: id("helper"),
        parentSpanId: id("handoff"),
        name: "invoke_agent bb-sentry-traces-test-helper",
        start: start + 2_000,
        end: start + 2_500,
        attributes: {
          ...shared,
          "sentry.op": "gen_ai.invoke_agent",
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.agent.name": "bb-sentry-traces-test-helper",
        },
      }),
      chat("chat:1", start + 2_500, now, true),
    ],
  };
}
