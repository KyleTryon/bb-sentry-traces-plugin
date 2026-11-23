# Changelog

All notable changes to this plugin are listed here. Versions follow
[Semantic Versioning](https://semver.org/); the Git tag for a release is
`v<version>`.

## Unreleased

## 0.1.0

First public release.

- Sends finished turns of bb threads to Sentry Agent Monitoring over Sentry's
  OTLP endpoint: `invoke_agent` spans per turn, `execute_tool` spans per call,
  subagent handoffs, inferred `chat` spans, and per-turn token usage.
- One Sentry conversation per thread (`gen_ai.conversation.id`).
- Works with every bb agent provider: Claude Code (including `delegation`
  subagents and forked Skills), Codex, Pi and ACP agents. Subagents are found
  by the shape of bb's events, not by tool names. Agents that report a cost
  but no tokens send their own cost (`gen_ai.cost.total_tokens`).
- Workflow runs exported as one trace per run, under their phases and calls,
  through bb's bundled Workflows plugin. With Workflows disabled, workers
  export as threads of their own.
- Trace provider contract (version 2): another plugin can group threads into
  one trace and name its agents by reporting them through this plugin's
  `report_threads` and `report_trace` RPC methods. This plugin calls no
  provider and names none. See
  [docs/trace-provider-contract.md](docs/trace-provider-contract.md).
- Off by default. Message content, including free-text errors, is a separate
  opt-in (`captureContent`) and is scrubbed for common secret shapes before it
  is cut and sent.
- Sends each turn once across restarts and retries. A turn that never ended
  is sent as interrupted; turning export off and on again sends nothing from
  the gap.
- `bb sentry-traces status`, `test` and `export` commands.
