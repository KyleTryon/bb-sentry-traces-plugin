# Sentry Traces for bb (unofficial)

A [bb](https://getbb.app) plugin that sends agent traces from bb threads to
[Sentry Agent Monitoring](https://docs.sentry.io/product/agents/): agent runs,
tool calls, model time, token usage and Conversations. It works with every bb
agent provider (Claude Code, Codex, Pi, ACP agents) and needs no other plugin.

This is a community plugin. It is not made or supported by Sentry.

## Install

```sh
bb plugin install git:https://github.com/KyleTryon/bb-sentry-traces-plugin-unofficial.git
```

To stay on a release line instead of the default branch, add a version range,
such as `…unofficial.git@^0.1.0`. Requires bb 0.50.0 or later.

## Set up

Nothing leaves your machine until you do both of these.

```sh
bb plugin config sentry-traces set dsn 'https://<key>@o<org>.ingest.us.sentry.io/<project>'
bb plugin config sentry-traces set enabled true
```

The DSN is under **Project settings > Client Keys (DSN)** in Sentry. It is
stored as a secret setting and is never logged or printed. Then check the
connection with one synthetic trace:

```sh
bb sentry-traces test
bb sentry-traces status
```

The synthetic trace is a small, made-up agent run. It shows in your Agents
dashboards like any other, with a made-up cost of well under a cent.

Self-hosted Sentry works when its version has the OTLP traces endpoint and
Agent Monitoring. A DSN on plain `http://` is accepted, but `status` warns
unless the host is `localhost`: traces and the key would travel unencrypted.

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `dsn` | none | The Sentry project to send to. The plugin reports needs-configuration until it is set; export picks up a new DSN at once, and `bb plugin reload sentry-traces` clears the notice. |
| `enabled` | `false` | Send traces. |
| `captureContent` | `false` | Also send prompts, replies, tool arguments and tool outputs. |
| `environment` | none | A label for Sentry's environment filter, such as `laptop`. |

Turning `enabled` on sends turns that finish from then on. It does not send a
thread's earlier history, and the same goes for turning it back on after a
pause or setting a DSN again: what happened in between is not sent.

## What you get in Sentry

| In bb | In Sentry |
| --- | --- |
| A thread | A conversation (`gen_ai.conversation.id` is the thread id) |
| A turn | An `invoke_agent <agent>` span, with the model it was requested with |
| A command, tool call, file read or edit, search | An `execute_tool <tool>` span, with status and exit code |
| A subagent | An `execute_tool <tool>` span for the call that started it (`Agent`, or the tool itself, such as `Skill`), recording the handoff in `gen_ai.transfer.target.name` and `gen_ai.transfer.mode`, with the subagent's `invoke_agent <kind>` span and its tool calls nested under it |
| Model time between calls | A `chat <model>` span, marked `bb.inferred` |
| The turn's token usage, or the agent's own cost | On one `chat` span of the turn, so cost is counted once |

A thread on its own produces one trace per turn. The workers of a
[workflow run](#workflow-runs) share one trace, and a thread that another
plugin claims as a [trace provider](#trace-providers) joins that plugin's
trace.

Each turn's `invoke_agent` span also says where and how it ran:

| Attribute | Meaning |
| --- | --- |
| `bb.environment.id`, `bb.environment.worktree`, `bb.host.id` | The environment and machine. `bb.environment.branch` needs `captureContent`, because bb names branches after the thread's title. |
| `bb.thread.parent_id`, `bb.thread.owner_id` | The parent thread, and the thread this one's life is tied to. |
| `bb.thread.origin`, `bb.thread.origin_plugin`, `bb.thread.hidden` | How the thread came to be. |
| `bb.turn.initiator`, `bb.turn.source`, `bb.turn.sender` | Who started the turn (`user`, `agent`, `system`), how, and from which thread. |
| `bb.permission_mode` | The permission mode the turn ran with. |
| `gen_ai.response.model`, `bb.model_fallback.reason` | The model that answered: the requested one, or the one the provider fell back to mid-turn. |
| `bb.rate_limit.status` | The provider's rate limit status during the turn. |
| `bb.context.used_tokens`, `bb.context.window_tokens` | How full the context window got. |

A subagent is named by its kind (`Explore`, `general-purpose`,
`code-review`) when bb records one, and `subagent` when it does not.

## What is sent

With `captureContent` off (the default), a span carries only:

- the tool's own name (`shell`, `Read`, `mcp__docs__search`), never the command
  line, file name, query or arguments. A tool or subagent name that is not a
  plain identifier is sent as `tool` or `subagent`.
- start and end times, status, exit code, and a fixed error type
- error messages only when they are a short code (`overloaded_error`,
  `ENOENT`). Free-text error messages are content.
- the model, reasoning level, token counts or cost, and the thread, turn and
  project ids

It does not carry prompts, replies, command lines, tool arguments, tool
outputs, file paths, error text, the thread title, or the task a subagent was
given. Without the first prompt, Sentry lists each conversation as untitled.

With `captureContent` on, spans also carry the prompt and replies
(`gen_ai.input.messages`, `gen_ai.output.messages`), each call's arguments and
result, error text, and the thread title. That text first passes a scrubber
that replaces common secret shapes, then caps each field, so a cut cannot
split a secret into a piece that no longer looks like one. It covers, among
others:

- API keys and tokens: Anthropic, OpenAI, GitHub, GitLab, Slack (and webhook
  URLs), Stripe, npm, Google, AWS, Sentry, JWTs
- PEM and PGP private keys
- credentials in URLs and connection strings, `Authorization`, `Cookie` and
  `X-API-Key` headers, `curl -u`, Azure account keys
- dotenv and YAML lines, and quoted fields, whose name says they hold a
  secret (`API_KEY=`, `DB_PASS:`, `"api-key": …`)

Where it cannot tell whether text is a secret it redacts: a command that only
names a credential in quotes, such as `grep 'API_KEY=' src && echo done`,
loses the rest of that line. The scrubber is a best effort, not a guarantee:
only turn this on for a Sentry project you would trust with the transcript.

## Commands

```
bb sentry-traces status [--json]
bb sentry-traces test [--json]
bb sentry-traces export [thread-id] [--turns N | --all] [--running] [--content] [--summary]
```

- `status` shows whether export is on, the Sentry host and project (never the
  key), what was sent, the last failure, and the trace providers that
  reported in the last 30 days.
- `test` sends one synthetic trace with fixed text. It works while `enabled`
  is off.
- `export` prints the OTLP JSON a thread would send. It sends nothing and
  records nothing.

## Workflow runs

A [Workflows](https://getbb.app) script runs outside any thread, so the only
trace of it is the worker threads it spawns. The plugin ties them back
together into one trace per workflow run:

```
invoke_workflow <name>                    sent when the run ends
├─ workflow.phase <n>
│   ├─ workflow.call <n>                  model, status, retries, cached
│   │   └─ invoke_agent <agent>           the worker thread's turns
│   └─ workflow.call <n>
└─ workflow.call <n>                      a call outside any phase
```

Every span carries `bb.workflow.run_id`, `bb.workflow.name` and
`bb.workflow.origin_thread_id` (the thread that started the workflow), and
`gen_ai.pipeline.name` is the workflow's name. Each worker is still its own
conversation.

Phase titles, call labels and error text are written by whoever wrote the
script, often a model, so they are sent only with `captureContent`; without it
phases and calls are numbered. A workflow name is sent only when it is a plain
identifier.

This reads two things from bb's bundled Workflows plugin: each worker thread's
Workflows metadata, and the `workflowRunView` RPC. That RPC is internal to
Workflows and may change. If it does, or Workflows is disabled or removed,
workers export on their own, one trace per turn, without waiting. If
Workflows fails for a moment, a worker's turns wait for it to answer again,
for up to 30 minutes, and then go out on their own.

## Trace providers

Another plugin can group threads into one trace of its own and describe that
trace's structure. An orchestration plugin, for example, can put a run's
coordinator and workers in one trace under the run, its steps and its
decisions:

```
<provider's root span>                    sent when the trace ends
├─ <provider's spans>                     steps, decisions, checks, … (final ones sent early)
│   └─ invoke_workflow <script>           a workflow run a span names
│       └─ workflow.call <n>
│           └─ invoke_agent <agent>       worker thread turns
└─ invoke_agent <agent>                   turns of a thread in the trace
```

This plugin knows nothing about what a provider's trace means, and asks no
plugin for it. A provider is any bb plugin that calls two RPC methods of this
one, `report_threads` and `report_trace`, described in
[docs/trace-provider-contract.md](docs/trace-provider-contract.md). Only
another plugin can call them; the app, the CLI and agents cannot. `bb
sentry-traces status` lists the providers that reported in the last 30 days.

- **Agents get the provider's names.** A provider can name the agent a thread
  runs as (`Senior Dev`); that becomes `gen_ai.agent.name`, with the agent's id
  in `bb.agent.id`. A thread no provider names is named by its bb provider
  (`claude-code`).
- **A thread belongs to one provider.** The first to claim it keeps it until
  it lets go, or until it has not reported for 30 days, as when it was
  removed. Each thread keeps its own conversation, and every span carries
  `bb.trace.provider`, `bb.trace.key` and the provider's own attributes.
- **A provider's spans are sent as they settle.** A provider reports its
  trace as a whole snapshot whenever it changes. A span it marks `final`, such
  as a model call it made, is sent within a minute or so, even while the trace
  is open. The rest, and the root, are sent once a snapshot says the trace has
  ended; until then the trace has no root. A trace still open after 30 days is
  sent as it stands, its root marked `bb.trace.state: "open"`. A turn that
  starts in a thread after its trace ended gets its own trace.
- **Workflow workers need no claim.** A worker takes its trace from the thread
  that started its workflow, and hangs under its workflow call.
- **Provider input is checked.** Attributes must be plain scalars, are capped
  in number and size, and cannot replace this plugin's own or Sentry's, carry
  content, or change token counts and cost. Text a provider marks as content
  is kept and sent only with `captureContent`, scrubbed. Reports are kept in
  plugin storage until sent; claims are kept while export is off too, so a
  thread claimed then is placed right once it is on.

A thread no provider claimed exports as one trace per turn, at once.

## Known limits

- **No per-request model spans.** Model calls happen inside the provider CLIs
  bb launches, which no plugin can observe. `chat` spans are inferred from the
  gaps between events, so there is no real request latency or time to first
  token. Sentry's Conversations view counts each inferred `chat` span as a
  turn or message, so one bb turn can show as several.
- **Token usage and cost are per turn at best.** bb keeps one running total
  per thread; a turn's usage is the difference since the last export. If
  several turns finish before one export, the last of them carries the usage
  for all (`bb.usage.turns`), including turns skipped after a long gap. A
  thread first seen after it already has history gets no usage on its first
  exported turn, and neither does the first turn after export is turned back
  on, unless that turn started after it was. A turn that is stopped before it
  ends may get none: Claude Code, for one, reports usage only when a turn
  finishes.
- **Agents that report no tokens.** ACP agents such as OpenCode, Antigravity
  and Grok report no token usage to bb. Where an agent reports its own cost in
  USD, that is sent as `gen_ai.cost.total_tokens`, which Sentry keeps as the
  cost; otherwise those threads show no tokens and no cost.
- **Handoffs follow OpenTelemetry's "agent as a tool" form.** There is no
  separate handoff span. Sentry stores `gen_ai.transfer.*` but, as of this
  writing, has no convention for them and may not show them anywhere yet.
  Some agents (Antigravity) run subagents out of bb's sight; their
  `invoke_agent` span covers only the call that started them.
- **Tool call ids are bb's.** `gen_ai.tool.call.id` is bb's id for the call;
  the provider's own id does not reach bb's events.
- **A workflow script's own code is not traced.** Its calls and the threads
  they spawn are; what the script does between calls is not.
- **A workflow run links to the thread that started it by attribute only**
  (`bb.workflow.origin_thread_id`). That thread's `bb_workflow_run` tool call
  stays in its own trace.
- **Tasks are not linked.** bb's Tasks offer no way to find a task from a
  thread. A task key appears only when a trace provider supplies one.
- **Background work that outlives its turn** is closed at the turn's end and
  marked `bb.span.running`. A turn with a background subagent still at work
  waits for it, up to two hours after the turn ends, so it usually goes out
  with the subagent's real end. Later turns are sent as usual meanwhile,
  without token usage: the usage waits until no turn of the thread is waiting,
  then goes on the last turn sent, with the number of turns it covers in
  `bb.usage.turns`.
- Sentry's direct OTLP endpoint drops span events; this plugin sends none.
- Spans take a few minutes to show in Sentry after they are sent.

## How it works

Plugin server code runs inside bb's server process, shared with bb and every
other plugin. So there is no Sentry SDK here, no global `Sentry.init()` and no
monkeypatching: the plugin builds OTLP/JSON and posts it with `fetch` to the
endpoint derived from the DSN
(`https://<ingest host>/api/<project>/integration/otlp/v1/traces`). It does not
follow redirects, so the key never goes anywhere but the DSN's host.

- On `thread.idle` and `thread.failed`, it reads the thread's events from
  where the last export stopped, folds them into turns, and sends the turns
  that finished since. Nothing is cached between exports.
- A turn that never ended, because bb or the agent stopped mid-turn, is sent
  as interrupted when the thread's next turn starts, or after six hours with
  no event.
- What was sent is kept in plugin storage, so a restart does not send a turn
  twice. Trace and span ids are hashes of stable keys, so a restart cannot
  fork a trace either. What is kept about a thread unused for 90 days is
  dropped; if it is used again, it starts at its newest turn.
- A failed send is logged and retried with backoff (1 minute up to 1 hour, 8
  attempts). Failures never affect a thread or a run. Turning export off or
  changing the DSN takes effect before the next turn of an export in
  progress.

## Development

```sh
git clone https://github.com/KyleTryon/bb-sentry-traces-plugin-unofficial.git
cd bb-sentry-traces-plugin-unofficial
npm install
npm run check          # typecheck, lint, unused-code check, tests
bb plugin install .    # install from this checkout
bb plugin dev          # rebuild and reload on save
```

CI runs the same checks on Linux, macOS and Windows, and builds the plugin
with the oldest supported bb, the latest release and the nightly. See
[AGENTS.md](AGENTS.md) for how the code is laid out, and
[CHANGELOG.md](CHANGELOG.md) for releases.

## Credits

The event-to-trace folding (`src/core/trace/`, `src/core/breakdown.ts`,
`src/core/text.ts`) is adapted from
[Agent Traces](https://github.com/charpeni/bb-plugins/tree/main/plugins/agent-traces)
by Nicolas Charpentier, MIT License. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT

Sentry and the Sentry logo are trademarks of Functional Software, Inc. This
plugin uses the logo to show where the data goes; it is not an official Sentry
product.
