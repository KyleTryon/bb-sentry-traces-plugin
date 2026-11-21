# Trace provider contract

Version 1.

The Sentry Traces plugin exports each bb thread on its own: one trace per
turn. A **trace provider** is any other bb plugin that knows some threads
belong together, such as an orchestrator that runs a coordinator and several
workers for one task. A provider tells the plugin two things:

- which trace a thread belongs to, where the thread's turns hang in it, and
  which agent the thread runs as;
- the trace's own structure, as a list of spans.

The plugin knows nothing about what a provider's trace means. It does not read
a provider's database or thread metadata. It calls two RPC methods on the
plugins named in its `providers` setting, through `bb.sdk.plugins.callRpc`.

A provider needs no Sentry code and no dependency on this plugin. The spans it
returns are plain data that follow OpenTelemetry's naming.

## Rules for every call

- Every request carries `"contract": 1`, and every answer must carry it back.
  An answer with another version is ignored.
- Times are milliseconds since the epoch.
- An answer with another version means "this provider has nothing to say":
  the thread exports on its own, and the plugin does not call the provider
  again for five minutes.
- An answer with the right version that does not match this page means the
  same for that one request: the same request is not made again for five
  minutes, and other requests are still made.
- A failed call means the provider could not be reached, and the plugin does
  not call it again for five minutes. From a provider that has never given a
  readable answer since the plugin loaded, that is final: the thread exports
  on its own. A provider that answered before and then fails, as during a
  reload, may still claim the thread, so the export waits and asks again, for
  up to 30 minutes of failures before it takes the provider to be gone.
- The plugin reads the fields below and ignores any others.
- Providers are asked in the order of the `providers` setting. The first one
  with an answer for a thread wins.

## `telemetry_thread_context`

Says where threads belong.

Input:

```json
{
  "contract": 1,
  "threads": [
    {
      "threadId": "thr_worker",
      "workflow": {
        "runId": "wf_7",
        "name": "orch-run-42-develop-1",
        "callId": "call_0",
        "callIndex": 0,
        "originThreadId": "thr_coordinator",
        "phase": "Implement",
        "provider": "claude-code",
        "model": "claude-sonnet-4-5",
        "reasoningLevel": "medium"
      }
    },
    { "threadId": "thr_coordinator" }
  ]
}
```

`workflow` is present when the thread is a worker of a bb Workflows run. It is
what Workflows says about the worker: its run and the name its script
declares, its call, the thread that started the run, and the phase and model
the call ran with. Use it to place or
name a worker you did not spawn yourself.

Output: one entry per requested thread, `null` for a thread that is not in a
trace of yours.

```json
{
  "contract": 1,
  "contexts": {
    "thr_coordinator": {
      "trace": {
        "key": "run_42",
        "endedAt": null,
        "pipeline": "feature-dev",
        "attributes": { "orchestrator.run_id": "run_42" }
      },
      "parent": null,
      "agent": { "id": "coordinator", "name": "Lead" },
      "attributes": { "orchestrator.role": "coordinator" }
    },
    "thr_worker": null
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `trace.key` | yes | Your id for the trace. Threads with the same key share one trace. |
| `trace.endedAt` | optional | When the trace ended. `null` while it can still grow. See [After a trace ends](#after-a-trace-ends). |
| `trace.pipeline` | optional | The workflow or pipeline the trace belongs to. Sent as `gen_ai.pipeline.name`. |
| `trace.attributes` | optional | Attributes for every span of the trace, including spans the plugin builds itself. |
| `parent` | optional | The `key` of the span this thread's turns hang under. `null` means the root. |
| `agent.id`, `agent.name` | optional | The agent the thread runs as. `name` becomes `gen_ai.agent.name`, the name Sentry lists agents by; `id` is sent as `bb.agent.id`. Without either, the thread is named by its bb provider, such as `claude-code`. |
| `model` | optional | The model to report when bb recorded none for a turn. |
| `attributes` | optional | Attributes for this thread's spans only. |

### Workflow workers

You do not have to answer for a worker. When a provider returns `null` for a
worker, the plugin looks at the thread that started the worker's workflow,
which it asked about in the same call. If that thread is in a trace of yours,
the worker joins the same trace. Its turns hang under its workflow call, and
the workflow run hangs under a span of yours (see
[Workflow runs](#workflow-runs)). A worker placed this way gets the trace's
attributes but no agent.

Answer for a worker when you can name its agent. Its place in the trace still
comes from its workflow call.

### After a trace ends

Keep answering for a thread after its trace has ended. A thread's last turn
often finishes after the trace does, and the plugin exports a turn only when
its thread goes idle.

Set `trace.endedAt` once the trace has ended. A turn that starts after that
time gets a trace of its own, outside yours. Without `endedAt`, every later
turn in the thread joins the finished trace.

## `telemetry_trace`

Returns a trace's own structure.

Input:

```json
{ "contract": 1, "traceKey": "run_42", "includeContent": false }
```

Output: the trace, or `"trace": null` when you have no such trace.

```json
{
  "contract": 1,
  "trace": {
    "key": "run_42",
    "ended": true,
    "pipeline": "feature-dev",
    "attributes": { "orchestrator.run_id": "run_42" },
    "spans": [
      {
        "key": "root",
        "parentKey": null,
        "name": "orchestrator.run feature-dev",
        "op": "orchestrator.run",
        "start": 1800000000000,
        "end": 1800000400000,
        "attributes": { "orchestrator.state": "completed" }
      },
      {
        "key": "step-develop-1",
        "parentKey": "root",
        "name": "orchestrator.step develop#1",
        "op": "orchestrator.step",
        "start": 1800000100000,
        "end": 1800000300000,
        "workflowName": "orch-run-42-develop-1"
      },
      {
        "key": "decision-1",
        "parentKey": "root",
        "name": "decide typesafe/jev-1.13",
        "op": "gen_ai.decide",
        "kind": "client",
        "start": 1800000050000,
        "end": 1800000050420,
        "attributes": {
          "gen_ai.operation.name": "decide",
          "gen_ai.request.model": "typesafe/jev-1.13",
          "gen_ai.usage.input_tokens": 400,
          "gen_ai.usage.output_tokens": 20
        }
      },
      {
        "key": "verify-1",
        "parentKey": "step-develop-1",
        "name": "orchestrator.verify",
        "op": "orchestrator.verify",
        "start": 1800000310000,
        "end": 1800000310000,
        "status": "error",
        "errorType": "verify_failed"
      }
    ]
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `ended` | yes | Whether the trace has ended. The plugin sends a trace's spans once, when this is `true`. |
| `pipeline`, `attributes` | optional | As in the thread context; they apply to every span. |
| `spans[].key` | yes | Your id for the span, unique in the trace. Thread contexts and other spans refer to it. |
| `spans[].parentKey` | optional | The parent span's key. Missing or unknown means the root. |
| `spans[].name` | yes | The span's name. Keep it to a small set of values; put ids in attributes. |
| `spans[].op` | optional | The span's operation, such as `orchestrator.step` or `gen_ai.decide`. |
| `spans[].start`, `.end` | yes | The span's times. |
| `spans[].status` | optional | `ok` or `error`. |
| `spans[].errorType` | optional | A short, fixed reason for an error, such as `verify_failed`. |
| `spans[].errorMessage` | optional | Free text about the error. Sent only as [content](#content). |
| `spans[].kind` | optional | `client` for a call to a model, else `internal`. |
| `spans[].attributes` | optional | The span's attributes. |
| `spans[].content` | optional | Attributes that hold user or model text. See [Content](#content). |
| `spans[].workflowName`, `.workflowRunId` | optional | The bb Workflows run this span started, by the name its script declares or by its run id. See [Workflow runs](#workflow-runs). |

At most 2,000 spans.

### The root

Exactly one span has the key `root` and no parent. Threads with
`"parent": null` hang under it. If a trace has no `root` span, the plugin
makes one that covers the other spans.

### When the trace is sent

The plugin asks for a trace about once a minute after it first exports a
thread that belongs to it, and sends the spans once `ended` is `true`. It then
stops asking. A trace that never ends is dropped after 30 days.

Thread turns are sent as they finish, before the trace's own spans. Until the
trace ends, it has no root in Sentry.

Return `"trace": null` only when the trace does not exist. The plugin then
sends a root marked `bb.trace.state: "deleted"` for the turns it already sent
into that trace, and stops asking.

### Workflow runs

The plugin builds a bb Workflows run's spans itself: the run, its phases, its
calls, and each worker's turns under its call. A provider only says where the
run hangs, by naming the workflow on the span that started it:

- `workflowName`, the name the workflow's script declares. Use this when you
  write the script yourself and give each one a unique name: you know the name
  before the run exists.
- `workflowRunId`, the run's id, when you know it.

You may learn which workflow a span started only after the workflow has run.
The plugin waits up to ten minutes after a workflow ends for a span to name
it. After that it hangs the workflow run where the thread that started it
hangs.

### Model calls

A span that is a model call of your own, such as a decision, can use
OpenTelemetry's `gen_ai` attributes, and Sentry will count its tokens and cost:

- `gen_ai.operation.name`, such as `decide` or `chat`;
- `gen_ai.request.model`, the raw model string;
- `gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`, where input
  includes cached tokens and output includes reasoning tokens.

Do not report a call that never happened, and do not report tokens that a bb
thread already accounts for: the plugin exports that thread too.

## Attributes

Attribute values must be strings, finite numbers or booleans. The plugin drops
anything else, and:

- keeps at most 64 attributes per span, and 2,000 characters per value;
- drops a key that is not a plain name (letters, digits, `.`, `_`, `-`);
- drops keys starting with `sentry.`, `bb.thread.`, `bb.turn.` or `bb.trace.`,
  and `gen_ai.conversation.id`;
- lets its own attributes win over a provider's with the same key.

Prefix your attributes with your plugin's name, such as `orchestrator.run_id`.

## Content

The plugin has a `captureContent` setting, off by default. It decides whether
prompts, replies, tool arguments and outputs leave the machine.

- `includeContent` in a request tells you whether content is wanted. When it
  is `false`, return no user or model text.
- Put text in `spans[].content` and `spans[].errorMessage`, never in `name`
  or `attributes`. The plugin sends those two fields only when `captureContent`
  is on, after scrubbing them for secrets and capping each at 8,000 characters.
- Scrub the text yourself first if you have a scrubber.

## Ids

Trace and span ids are hashes of the provider's plugin id, the trace key and
the span key. So a thread's turns and the trace's own spans link up without
talking to each other, and a restart cannot fork a trace. Keep `trace.key` and
span keys stable for the life of a trace.
