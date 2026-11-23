# Working on this plugin

A bb plugin that turns bb thread events into OpenTelemetry traces and posts
them to Sentry's OTLP endpoint. Read [README.md](README.md) for what it sends
and [docs/trace-provider-contract.md](docs/trace-provider-contract.md) for the
contract other plugins use to report traces to it.

## Rules

- **Privacy first.** With `captureContent` off, nothing a user or model wrote
  may leave the machine: no prompts, replies, command lines, paths, arguments,
  outputs, titles or free-text errors. Names must be plain identifiers or a
  fixed fallback. Every new attribute needs a test in `tests/privacy.test.ts`
  that shows what it sends with content off.
- **Content is scrubbed, then cut.** Use the helpers in `src/core/scrub/`; never
  cut text before scrubbing it, and never split a surrogate pair.
- **No third-party plugins.** This plugin calls no other plugin except bb's
  bundled Workflows, and names none in code, settings, tests or docs. Other
  plugins integrate by calling its RPC methods. `tests/architecture.test.ts`
  checks this.
- **Never break bb.** Plugin code runs in bb's server process. Event handlers
  return at once and never throw; the export reports its own failures. No
  Sentry SDK, no global instrumentation.
- **Send each turn once.** What was sent lives in plugin storage, and trace and
  span ids are hashes of stable keys. A restart or retry must never send a
  turn twice or fork a trace.
- **Every agent provider.** Claude Code, Codex, Pi and ACP agents record events
  differently. Detect shapes, not provider names, and add a fixture to
  `tests/providers-compat.test.ts` (with all user content replaced) for a new
  shape.

## Layout

| Path | What it holds |
| --- | --- |
| `src/core/` | Pure event-to-trace logic: folding events into turns (`trace/`), OTLP building, token usage, scrubbing. Imports nothing outside `core/` but Node builtins. |
| `src/integrations/` | What other plugins report: trace providers (`providers/`, the RPC methods this plugin serves) and bb Workflows (`workflows/`). Never imports `export/`. |
| `src/export/` | The export loop: what to send and when, storage, retries, sweeps. |
| `src/server.ts`, `src/cli.ts` | Settings, event wiring, background service, the `bb sentry-traces` CLI. |
| `tests/` | `plugin.test.ts` drives the whole plugin through a fake bb host; the other files cover one subject each. |

## Commands

```sh
npm install
npm run check     # typecheck, lint (warnings fail), knip, tests
bb plugin build   # compile dist/
bb plugin dev     # rebuild and reload on save
bb sentry-traces export <thread-id> --summary   # what a real thread would send
```

## Releasing

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts` (a test
   keeps them equal), and move the `Unreleased` notes in `CHANGELOG.md` under
   the new version (a test checks it has notes).
2. `npm run check` and `bb plugin build` pass.
3. Commit, tag `vX.Y.Z`, push the commit and the tag. CI checks the tag
   matches `package.json`.

Raise `engines.bb` and the `@get-bb/plugin-sdk` pin together, on purpose:
the pin is the SDK of the oldest bb the plugin supports, and CI builds with
that bb.
