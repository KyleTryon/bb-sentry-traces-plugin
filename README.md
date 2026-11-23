# Sentry Traces for bb (unofficial)

A [bb](https://getbb.app) plugin that sends agent traces from bb threads to
[Sentry Agent Monitoring](https://docs.sentry.io/product/agents/): agent runs,
tool calls, model time, token usage and Conversations.

This is a community plugin. It is not made or supported by Sentry.

## What you get in Sentry

| In bb | In Sentry |
| --- | --- |
| A thread | A conversation (`gen_ai.conversation.id` is the thread id) |
| A turn | An `invoke_agent <agent>` span, with the model it was requested with |
| A command, tool call, file read or edit, search | An `execute_tool <tool>` span, with status and exit code |
| A subagent | An `execute_tool Agent` span that records the handoff (`gen_ai.transfer.target.name`, `gen_ai.transfer.mode`), with the subagent's `invoke_agent <kind>` span and its tool calls nested under it |
| Model time between calls | A `chat <model>` span, marked `bb.inferred` |
| The turn's token usage | On one `chat` span of the turn, so cost is counted once |

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
| `gen_ai.response.model`, `bb.model_fallback.reason` | Set when the provider fell back to another model mid-turn. |
| `bb.rate_limit.status` | The provider's rate limit status during the turn. |
| `bb.context.used_tokens`, `bb.context.window_tokens` | How full the context window got. |

## Install

```bash
git clone <this repository> bb-sentry-traces
cd bb-sentry-traces
npm install --include=dev
bb plugin install .
```

## Set up

Nothing leaves your machine until you do both of these.

```bash
bb plugin config sentry-traces set dsn 'https://<key>@o<org>.ingest.sentry.io/<project>'
bb plugin config sentry-traces set enabled true
```

The DSN is under **Project settings > Client Keys (DSN)** in Sentry. It is
stored as a secret setting and is never logged or printed. Then check the
connection with one synthetic trace:

```bash
bb sentry-traces test
bb sentry-traces status
```

### Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `dsn` | none | The Sentry project to send to. The plugin reports needs-configuration until it is set; export picks up a new DSN at once, and `bb plugin reload sentry-traces` clears the notice. |
| `enabled` | `false` | Send traces. |
| `captureContent` | `false` | Also send prompts, replies, tool arguments and tool outputs. |
| `environment` | none | A label for Sentry's environment filter, such as `laptop`. |

## What is sent

With `captureContent` off (the default), a span carries only:

- the tool's own name (`shell`, `Read`, `mcp__docs__search`), never the command
  line, file name, query or arguments
- start and end times, status, exit code, and a fixed error type
- the model, reasoning level, token counts, and the thread, turn and project ids
- provider and bb error messages (such as `overloaded_error`)

It does not carry prompts, replies, command lines, tool arguments, tool
outputs, file paths, the thread title, or the task a subagent was given. A
subagent is named by its kind (`Explore`, `general-purpose`), or `subagent`
when bb does not record one.

With `captureContent` on, spans also carry the prompt and replies
(`gen_ai.input.messages`, `gen_ai.output.messages`), each call's arguments and
result, and the thread title. That text first passes a scrubber that replaces
common secret shapes (API keys, tokens, PEM keys, credentials in URLs, dotenv
lines, quoted fields such as `"api_key": "…"`) and then caps each field, so a
cut cannot split a secret into a piece that no longer looks like one. Where
it cannot tell whether text is a secret it redacts: a command that only names
a credential in quotes, such as `grep 'API_KEY=' src && echo done`, loses the
rest of that line. The scrubber is a best effort, not a guarantee:
only turn this on for a Sentry project you would trust with the transcript.

Turning the plugin on sends turns that finish from then on. It does not send
a thread's earlier history.

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

This reads two things from the bundled Workflows plugin: each worker thread's
Workflows metadata, and the `workflowRunView` RPC. That RPC is internal to
Workflows and may change. If it does, or Workflows is disabled or removed,
workers export on their own, one trace per turn, without waiting.

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
  it lets go. Each thread keeps its own conversation, and every span carries
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
  in number and size, and cannot replace this plugin's own or Sentry's. Text a
  provider marks as content is kept and sent only with `captureContent`,
  scrubbed. Reports are kept in plugin storage until sent; claims are kept
  while export is off too, so a thread claimed then is placed right once it
  is on.

A thread no provider claimed exports as one trace per turn, at once.

## Known limits

- **No per-request model spans.** Model calls happen inside the provider CLIs
  bb launches, which no plugin can observe. `chat` spans are inferred from the
  gaps between events, so there is no real request latency or time to first
  token.
- **Token usage and cost are per turn at best.** bb keeps one running total
  per thread; a turn's usage is the difference since the last export. If
  several turns finish before one export, the last of them carries the usage
  for all (`bb.usage.turns`). A thread first seen after it already has history
  gets no usage on its first exported turn. Providers that report no token
  usage to bb show none, and a turn that is stopped before it ends may get
  none either: Claude Code, for one, reports usage only when a turn finishes.
- **Only the requested model is known.** The plugin sends
  `gen_ai.request.model` and no `gen_ai.response.model`; Sentry fills the
  response model from the request and still works out cost.
- **Handoffs follow OpenTelemetry's "agent as a tool" form.** There is no
  separate handoff span. Sentry stores `gen_ai.transfer.*` but, as of this
  writing, has no convention for them and may not show them anywhere yet.
- **Tool call ids are bb's.** `gen_ai.tool.call.id` is bb's id for the call;
  the provider's own id does not reach bb's events.
- **A workflow script's own code is not traced.** Its calls and the threads
  they spawn are; what the script does between calls is not.
- **A workflow run links to the thread that started it by attribute only**
  (`bb.workflow.origin_thread_id`). That thread's `bb_workflow_run` tool call
  stays in its own trace.
- **Tasks are not linked.** The Tasks plugin offers no way to find a task from
  a thread. A task key appears only when a trace provider supplies one.
- **bb's reported cost is not sent.** Some providers report a cost to bb but no
  token usage; those threads show no tokens and no cost.
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
(`https://<ingest host>/api/<project>/integration/otlp/v1/traces`).

- On `thread.idle` and `thread.failed`, it reads the thread's events from
  where the last export stopped, folds them into turns, and sends the turns
  that finished since. Nothing is cached between exports.
- What was sent is kept in plugin storage, so a restart does not send a turn
  twice. Trace and span ids are hashes of stable keys, so a restart cannot
  fork a trace either.
- A failed send is logged and retried with backoff (1 minute up to 1 hour, 8
  attempts). Failures never affect a thread or a run.

## Development

```bash
npm run check     # typecheck and tests
bb plugin build   # compile dist/
bb plugin dev     # rebuild and reload on save
```

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
