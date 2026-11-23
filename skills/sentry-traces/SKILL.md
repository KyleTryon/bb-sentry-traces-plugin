---
name: sentry-traces
description: Check, test, or troubleshoot the export of bb agent traces to Sentry Agent Monitoring with the `bb sentry-traces` CLI. Use when the user asks why traces, token usage or conversations are missing in Sentry, wants to set up or verify the Sentry DSN, or wants to see what a thread would send.
---

# Sentry Traces

The Sentry Traces plugin sends finished turns of bb threads to Sentry as
OpenTelemetry traces: one `invoke_agent` span per turn, with `execute_tool`
spans for its calls and inferred `chat` spans for model time. A subagent is an
`execute_tool` span carrying `gen_ai.transfer.*`, with the subagent's own
`invoke_agent` span under it.

It sends nothing until a DSN is set and `enabled` is on.

## Commands

| Command | Effect |
| --- | --- |
| `bb sentry-traces status` | Shows whether export is on, the Sentry host and project, counts, the last failure, and the trace providers that reported in the last 30 days. Add `--json` for code. |
| `bb sentry-traces test` | Sends one synthetic trace with fixed text and prints its trace id. Works while `enabled` is off. |
| `bb sentry-traces export [thread-id]` | Prints the OTLP JSON the thread would send. Sends nothing. Defaults to the current thread and its newest finished turn. |

`export` options: `--turns N` (1-50), `--all`, `--running` (also the turn in
progress), `--summary` (one line per span instead of JSON), `--content`
(include message content in the printout).

## Settings

Change settings with `bb plugin config sentry-traces set <key> <value>`.

| Key | Default | Meaning |
| --- | --- | --- |
| `dsn` | none | Sentry DSN. Secret. |
| `enabled` | `false` | Send traces. |
| `captureContent` | `false` | Also send prompts, replies, tool arguments and outputs. |
| `environment` | none | Environment label in Sentry. |

## Rules

- Do not turn on `enabled` or `captureContent`, and do not set or change the
  DSN, unless the user asked for that. Both settings send the user's data to
  an outside service.
- Never print the DSN. `status` shows only its host and project id.
- `test` sends a request to Sentry. Run it when the user wants the connection
  checked, not as a routine step.
- `export` is safe to run: it reads the thread and prints, nothing more. Its
  output can be large; start with `--summary`.

## Troubleshooting

1. Run `bb sentry-traces status`. `Sending: no` names what is missing. It
   also warns when the DSN uses plain `http://` to a host other than
   localhost.
2. If sending is on but nothing arrives, run `bb sentry-traces test`. A 401 or
   403 means the DSN is wrong or belongs to another project.
3. Read `bb plugin logs sentry-traces` for send failures. Sends that could
   not reach Sentry, or that got a 429 or 5xx, retry with backoff for up to 8
   attempts. A refused key (401, 403) is not retried; the next turn tries
   again, and a turn waiting on a background subagent is still looked at
   again. A DSN that answers with a redirect is refused, not followed. A
   turn Sentry refuses as it is (400, 413, 422) is skipped and logged, so
   the turns after it still go.
4. A turn is sent when its thread goes idle or fails, not while it runs.
5. Token usage is missing on a thread's first exported turn when the thread
   already had history, on the first turn after export was turned back on,
   and for providers that report no usage to bb. ACP agents (OpenCode,
   Antigravity, Grok) report no tokens; where one reports its own cost in
   USD, that is sent as the cost instead.
6. Conversations show as untitled while `captureContent` is off, since the
   title comes from the first prompt, which is content. Do not turn it on to
   fix that unless the user asks.
7. Error messages without content capture are sent only when they are a
   short code such as `overloaded_error`; other error text needs
   `captureContent`.
8. A workflow run's workers share one trace, read from the Workflows plugin's
   thread metadata and its `workflowRunView` RPC. If either is unreadable, each
   worker exports on its own, including while Workflows is disabled. The
   run's own spans are sent when the run ends.
9. Threads join another plugin's trace only when that plugin claims them by
   calling this plugin's `report_threads` RPC, before the thread's turn ends.
   `status` lists each provider that reported in the last 30 days, with the
   threads it claims and its open traces. A provider's own spans are sent
   from what it reports with `report_trace`: final spans within a minute or
   so, the rest once it reports the trace ended. Otherwise each turn is its
   own trace. The contract is in the plugin's
   `docs/trace-provider-contract.md`.
