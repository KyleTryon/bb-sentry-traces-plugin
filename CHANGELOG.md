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
- Workflow runs exported as one trace per run, under their phases and calls.
- Trace provider contract (version 2), so another plugin can group threads
  into one trace and name its agents by reporting them through this plugin's
  `report_threads` and `report_trace` RPC methods. See
  [docs/trace-provider-contract.md](docs/trace-provider-contract.md).
- Off by default. Message content is a separate opt-in (`captureContent`) and
  is scrubbed for common secret shapes.
- `bb sentry-traces status`, `test` and `export` commands.
