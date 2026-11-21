Send your bb agents' traces to Sentry Agent Monitoring: every turn as an agent
run, with its tool calls, model time and token usage, grouped into one
conversation per thread. This is a community plugin, not made by Sentry.

## What you get

- **Agent runs.** Each turn is an `invoke_agent` span with the model it ran on.
- **Tool calls.** Commands, tool calls, file reads and edits, and searches are
  `execute_tool` spans with status and exit code. A subagent shows as a
  handoff: the tool call that started it, with the subagent's own run nested
  under it.
- **Tokens and cost.** A turn's token usage is sent once, in the form Sentry
  uses to work out cost.
- **Conversations.** Turns of one thread group into one Sentry conversation.
- **Workflow runs as one trace.** The worker threads of a Workflows run are
  tied back together under the run, its phases and its calls.
- **Orchestrated runs as one trace.** Another plugin, such as an orchestrator,
  can group its threads into one trace and name its agents, through a small
  open contract.
- **Where it ran.** Each agent run carries its environment, machine, thread
  origin, permission mode and any model fallback.

## Off until you turn it on

Nothing leaves your machine until you set a Sentry DSN and turn on `enabled`.
By default the plugin sends only names, timing, status and token counts.
Prompts, replies, command lines, tool arguments and outputs are sent only if
you also turn on `captureContent`, and then pass through a secret scrubber.

## How it works

The plugin reads a thread's events when it goes idle and posts OTLP traces
straight to your Sentry project. It uses no Sentry SDK and does not instrument
bb. Model calls happen inside the provider CLIs, so model spans are inferred
from the gaps between events and token usage is per turn.

## For agents

`bb sentry-traces status` shows whether export is on and how the last exports
went. `bb sentry-traces test` sends one synthetic trace. `bb sentry-traces
export <thread-id>` prints what a thread would send without sending it.
