# Security

## Reporting a vulnerability

Report it privately through this repository's **Security > Report a
vulnerability** page (a GitHub security advisory). Do not open a public issue
for a leak of user data or a secret.

Include what was sent that should not have been, the setting values
(`enabled`, `captureContent`, `providers`; never your DSN), and, if you can,
the output of `bb sentry-traces export <thread-id> --summary`.

This is a community plugin, not a Sentry product. Do not report problems with
it to Sentry.

## What counts

- Anything the plugin sends with `captureContent` off beyond what the README's
  [What is sent](README.md#what-is-sent) section lists.
- A secret that survives the scrubber with `captureContent` on, in a shape the
  README says it covers.
- The DSN appearing in logs, CLI output, span data or error messages.
- A trace provider plugin, or a thread's events, making the plugin throw in
  bb's server process, or send spans into a trace it does not own.

## How the plugin limits what it sends

- Nothing is sent until a DSN is set and `enabled` is on. `bb sentry-traces
  test` sends fixed, synthetic text only.
- Message content (prompts, replies, tool arguments and outputs, titles) is a
  second opt-in, `captureContent`, and is scrubbed for common secret shapes
  and capped in size before it is sent. The scrubber is a best effort.
- The DSN is a secret setting. Only its host and project id are ever shown.
- The plugin sends to the DSN's host only, with `fetch`. It loads no Sentry
  SDK and does not instrument bb or other plugins.
