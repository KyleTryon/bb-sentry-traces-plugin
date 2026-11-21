/**
 * `bb sentry-traces`: check the setup, send one synthetic trace, and look at
 * what a thread would send without sending it.
 */
import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { Exporter, ExportSettings } from "./exporter.js";
import { envelope, span as otlpSpan, spanIdFor, traceIdFor, type OtlpSpan } from "./otlp.js";
import { parseDsn, sendSpans, type Fetch } from "./sentry.js";
import { VERSION } from "./version.js";

export const CLI_NAME = "sentry-traces";

/** Larger exports are refused, not clipped: clipped JSON is not JSON. */
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

export interface CliDeps {
  exporter: Exporter;
  settings: () => Promise<ExportSettings>;
  fetch?: Fetch;
  now?: () => number;
}

function ago(at: number | null, now: number): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1_000));
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 36 * 3_600) return `${Math.round(seconds / 3_600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

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

function describeSpan(span: OtlpSpan): string {
  const ms = (BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)) / 1_000_000n;
  const failed = span.status.code === 2 ? "  ERROR" : "";
  return `${span.parentSpanId ? "  " : ""}${span.name}  ${ms}ms${failed}`;
}

export function registerCli(bb: Pick<BbPluginApi, "cli">, deps: CliDeps): void {
  const now = deps.now ?? Date.now;

  bb.cli.register(
    defineCli({
      name: CLI_NAME,
      summary: "Check and test the export of agent traces to Sentry",
      description:
        "Traces are sent only when the plugin's `enabled` setting is on and a DSN is set. " +
        `Change settings with \`bb plugin config ${CLI_NAME} set <key> <value>\`.`,
      commands: {
        status: cliCommand({
          summary: "Show whether export is on, where it sends, and how the last exports went",
          options: {
            json: { type: "boolean", description: "Print machine-readable JSON" },
          },
          async run(input) {
            const settings = await deps.settings();
            const dsn = parseDsn(settings.dsn);
            const stats = await deps.exporter.stats();
            const queues = await deps.exporter.queueSizes();
            const providers = await deps.exporter.providers.status();
            const report = {
              version: VERSION,
              enabled: settings.enabled,
              // The host and project only: the key never leaves the settings.
              dsn: dsn.ok
                ? { configured: true, host: dsn.target.host, projectId: dsn.target.projectId }
                : { configured: false, problem: dsn.reason },
              sending: settings.enabled && dsn.ok,
              captureContent: settings.captureContent,
              environment: settings.environment || null,
              stats,
              pendingRetries: queues.retries,
              openTraces: queues.openTraces,
              openWorkflows: queues.openWorkflows,
              providers,
            };
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(report) };
            const at = now();
            const lines = [
              `Sending: ${report.sending ? "yes" : "no"}`,
              `  enabled: ${settings.enabled ? "on" : "off"}`,
              dsn.ok
                ? `  DSN: set (${dsn.target.host}, project ${dsn.target.projectId})`
                : `  DSN: ${dsn.reason}`,
              `  content capture: ${settings.captureContent ? "on (prompts, replies, tool arguments and outputs are sent)" : "off (names, timing, status and token counts only)"}`,
              `  environment: ${settings.environment || "(none)"}`,
              `Sent: ${stats.turnsSent} turns, ${stats.spansSent} spans, ${stats.workflowsSent} workflow runs, ${stats.tracesSent} provider traces`,
              `  last success: ${ago(stats.lastSuccessAt, at)}`,
              `  failures: ${stats.failures}${stats.lastError ? ` (last ${ago(stats.lastFailureAt, at)}: ${stats.lastError})` : ""}`,
              `  waiting to retry: ${queues.retries} threads`,
              `  workflow runs in progress: ${queues.openWorkflows}`,
              `  provider traces in progress: ${queues.openTraces}`,
              ...(providers.length === 0
                ? ["Trace providers: none"]
                : providers.map(
                    (provider) =>
                      `Trace provider ${provider.provider}: ${
                        provider.available === null
                          ? "not asked yet"
                          : provider.available
                            ? "answering"
                            : "no answer (its threads export on their own)"
                      }`,
                  )),
            ];
            if (!report.sending) {
              lines.push(
                "",
                dsn.ok
                  ? `Turn it on with: bb plugin config ${CLI_NAME} set enabled true`
                  : `Set a DSN with: bb plugin config ${CLI_NAME} set dsn <dsn>`,
              );
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),

        test: cliCommand({
          summary: "Send one synthetic trace to Sentry to check the DSN",
          description:
            "Sends a made-up agent run with a tool call, a handoff to a subagent, and fixed text. It contains no " +
            "thread data and works while `enabled` is off, since running it is the consent.",
          options: {
            json: { type: "boolean", description: "Print machine-readable JSON" },
          },
          async run(input) {
            const settings = await deps.settings();
            const dsn = parseDsn(settings.dsn);
            if (!dsn.ok) {
              throw new PluginCliError(dsn.reason, {
                code: "not_configured",
                hint: `Set one with \`bb plugin config ${CLI_NAME} set dsn <dsn>\`.`,
              });
            }
            const at = now();
            const { traceId, spans } = syntheticSpans(at, at.toString(36));
            const result = await sendSpans(
              dsn.target,
              spans,
              { pluginVersion: VERSION, environment: settings.environment.trim() || null },
              deps.fetch,
            );
            if (!result.ok) {
              throw new PluginCliError(result.message, {
                code: "send_failed",
                hint: "Check that the DSN belongs to the project you expect and that this machine can reach Sentry.",
              });
            }
            const report = { ok: true, traceId, spans: result.spans, host: dsn.target.host };
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(report) };
            return {
              exitCode: 0,
              stdout: [
                `Sent ${result.spans} synthetic spans to ${dsn.target.host} (project ${dsn.target.projectId}).`,
                `Trace id: ${traceId}`,
                "It can take a minute to show in Sentry under Explore > Traces and AI > Agents.",
              ].join("\n"),
            };
          },
        }),

        export: cliCommand({
          summary: "Print the OTLP JSON a thread would send, without sending it",
          description:
            "Reads the thread's finished turns and prints the request body. Nothing is sent " +
            "and nothing is recorded as sent. Token usage is known per turn only at export time, " +
            "so it is left out unless every turn of the thread is included.",
          positionals: [
            {
              name: "thread",
              description: "Thread id; defaults to the thread the command runs in",
            },
          ],
          options: {
            turns: {
              type: "integer",
              min: 1,
              max: 50,
              default: 1,
              description: "How many of the newest finished turns to include (1-50)",
            },
            all: { type: "boolean", description: "Include every finished turn" },
            running: {
              type: "boolean",
              description: "Also include the turn in progress, ended at the current time",
            },
            content: {
              type: "boolean",
              description:
                "Include prompts, replies, tool arguments and outputs even when the captureContent setting is off",
            },
            summary: {
              type: "boolean",
              description: "Print one line per span instead of the JSON",
            },
          },
          async run(input, ctx) {
            const threadId = input.positionals.thread ?? ctx.threadId;
            if (!threadId) {
              throw new PluginCliError("No thread to export.", {
                code: "thread_required",
                hint: `Pass a thread id: \`bb ${CLI_NAME} export <thread-id>\`.`,
              });
            }
            const thread = await deps.exporter.threadInfo(threadId);
            if (!thread) {
              throw new PluginCliError(`No thread with id ${threadId}.`, {
                code: "thread_not_found",
                hint: "Run `bb thread list` to see thread ids.",
              });
            }
            const settings = await deps.settings();
            const captureContent = settings.captureContent || input.options.content === true;
            const preview = await deps.exporter.preview(thread, {
              captureContent,
              turns: input.options.all ? "all" : input.options.turns,
              includeRunning: input.options.running === true,
            });
            if (preview.turns === 0) {
              throw new PluginCliError(`Thread ${threadId} has no finished turn yet.`, {
                code: "no_finished_turn",
                hint: "Add --running to include the turn in progress.",
              });
            }
            if (input.options.summary) {
              const traces = new Set(preview.spans.map((span) => span.traceId)).size;
              return {
                exitCode: 0,
                stdout: [
                  `${preview.turns} turns, ${preview.spans.length} spans, ${traces} traces` +
                    (preview.workflow ? `, workflow run ${preview.workflow.runId}` : "") +
                    (preview.trace ? `, ${preview.trace.provider} trace ${preview.trace.traceKey}` : ""),
                  ...preview.spans.map(describeSpan),
                ].join("\n"),
              };
            }
            const body = JSON.stringify(
              envelope(preview.spans, {
                pluginVersion: VERSION,
                environment: settings.environment.trim() || null,
              }),
              null,
              2,
            );
            if (Buffer.byteLength(body, "utf8") > MAX_EXPORT_BYTES) {
              throw new PluginCliError(
                `The export is larger than ${MAX_EXPORT_BYTES / 1024 / 1024} MiB.`,
                {
                  code: "export_too_large",
                  hint: "Ask for fewer turns with --turns, or use --summary.",
                },
              );
            }
            return { exitCode: 0, stdout: body };
          },
        }),
      },
    }),
  );
}
