# Trace provider contract

Version 2.

The Sentry Traces plugin exports each bb thread on its own: one trace per
turn. A **trace provider** is any other bb plugin that knows some threads
belong together, such as an orchestration plugin that runs a coordinator and
several workers for one task. A provider tells the plugin two things:

- which trace a thread belongs to, where the thread's turns hang in it, and
  which agent the thread runs as;
- the trace's own structure, as a list of spans.

The provider pushes both by calling two RPC methods of this plugin through
`bb.sdk.plugins.callRpc`. The plugin calls no provider and knows none by
name. It does not read a provider's database or thread metadata, and it knows
nothing about what a provider's trace means.

A provider needs no Sentry code and no dependency on this plugin. What it
sends is plain data that follows OpenTelemetry's naming. When Sentry Traces is
not installed or is disabled, the call fails; catch that and carry on.

Version 1, in which this plugin asked providers listed in a `providers`
setting, is no longer supported.

## Rules for every call

- Every call carries `"contract": 2`, and every answer carries it back. A call
  with another version is refused with an `invalid` error that names the
  version this plugin speaks, whatever else the call holds, so a call written
  for another version gets that answer rather than a list of fields.
- Only another bb plugin may call. Calls from the app, the `bb` CLI or an
  agent are refused with `forbidden`. bb tells this plugin which plugin
  called, and that plugin id is your provider id: it is sent as
  `bb.trace.provider` and goes into every trace and span id.
- A call on version 2 that does not match this page is refused with
  `invalid_input`, and nothing of it is kept. The plugin ignores fields it
  does not know.
- Times are milliseconds since the epoch.
- Every answer says whether export is on (`sending`). You may skip building
  snapshots while it is `false`, but keep claiming threads: a claim made
  while export is off is used once it is on.

### Errors

A refused call fails with one of these codes, in the order they are checked,
and nothing of it is kept:

| Code | When |
| --- | --- |
| `invalid_input` | A call that names version 2, or no version, and does not match this page: a missing or mistyped field, more than 200 threads or 2,000 spans, a key over 200 characters, a name, op, pipeline, model or other short text over 1,000 characters, a time out of range, or a `report_trace` call with both or neither of `trace` and `deleted`. The error lists the fields. |
| `forbidden` | The caller is not another bb plugin: the app, the `bb` CLI, an agent, or this plugin itself. |
| `invalid` | The call names a contract version other than 2, whatever else it holds. The message names version 2. |
| `invalid` | A `report_trace` snapshot too large to keep: over 4 MB as sent, a span over 128 KB once checked (not counting its content and error message), or a trace whose pipeline and attributes take over 192 KB once checked. The message says which. |

Any other code, such as `handler_error`, means the plugin could not store the
report. Try again later.

## Example

```ts
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const SENTRY_TRACES = "sentry-traces";
const answer = z.object({ contract: z.number(), sending: z.boolean() }).loose();

async function reportToSentryTraces(bb: BbPluginApi, method: string, input: object) {
  try {
    return await bb.sdk.plugins.callRpc({
      pluginId: SENTRY_TRACES,
      method,
      input: { contract: 2, ...input },
      outputSchema: answer,
    });
  } catch {
    return null; // Not installed, disabled, or an older version: nothing to do.
  }
}

// When a run starts a thread, before the thread's first turn ends:
await reportToSentryTraces(bb, "report_threads", {
  threads: [
    {
      threadId: coordinatorThreadId,
      context: {
        trace: { key: run.id, pipeline: "feature-dev" },
        agent: { id: "coordinator", name: "Lead" },
      },
    },
  ],
});

// Whenever the run changes, and once after it ends:
await reportToSentryTraces(bb, "report_trace", { trace: snapshotOf(run) });
```

## `report_threads`

Claims threads for a trace of yours, or lets them go.

Claim a thread before its first turn ends. The plugin places a turn when it
exports it, as the thread goes idle, and a turn sent on its own stays there.
Report again whenever a thread's context changes, such as when its trace
ends.

Input: at most 200 threads per call.

```json
{
  "contract": 2,
  "threads": [
    {
      "threadId": "thr_coordinator",
      "context": {
        "trace": {
          "key": "run_42",
          "endedAt": null,
          "pipeline": "feature-dev",
          "attributes": { "example.run_id": "run_42" }
        },
        "parent": null,
        "agent": { "id": "coordinator", "name": "Lead" },
        "attributes": { "example.role": "coordinator" }
      }
    },
    { "threadId": "thr_done", "context": null }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `trace.key` | yes | Your id for the trace. Threads with the same key share one trace. |
| `trace.endedAt` | optional | When the trace ended. `null` while it can still grow. See [After a trace ends](#after-a-trace-ends). |
| `trace.pipeline` | optional | The workflow or pipeline the trace belongs to. Sent as `gen_ai.pipeline.name`. |
| `trace.attributes` | optional | Attributes for every span of the trace, including spans the plugin builds itself. |
| `parent` | optional | The `key` of the span this thread's turns hang under. `null` means the root. |
| `agent.id`, `agent.name` | optional | The agent the thread runs as. `name` (one line, cut to 80 characters) becomes `gen_ai.agent.name`, the name Sentry lists agents by; `id` is sent as `bb.agent.id`. Without either, the thread is named by its bb provider, such as `claude-code`. |
| `model` | optional | The model to report when bb recorded none for a turn. |
| `attributes` | optional | Attributes for this thread's spans only. |

A `null` context clears your claim of the thread.

Output: one result per thread.

```json
{ "contract": 2, "sending": true, "results": { "thr_coordinator": "ok", "thr_done": "ok" } }
```

| Result | Meaning |
| --- | --- |
| `ok` | Stored, or cleared. |
| `conflict` | Another provider claimed the thread first. It stays theirs until they clear it; you cannot clear it either. |
| `invalid` | The claim is larger than 64 KB once checked. Send fewer or shorter attributes. |
| `limit` | You already claim 5,000 threads. Clear the claims of threads you are done with. Claiming a thread you already claim again is always taken. |

A thread no provider claimed exports on its own. A claim is dropped when its
thread is deleted, and after 90 days in which neither the claim nor the
thread's export changed. All of a provider's claims are dropped once it has
not called either method for 30 days, so a provider that was removed does
not hold threads from the others for good.

### Workflow workers

You do not have to claim a bb Workflows worker. A worker no provider claimed
joins the trace of the thread that started its workflow, when that thread is
claimed. Its turns hang under its workflow call, and the workflow run hangs
under a span of yours (see [Workflow runs](#workflow-runs)). A worker placed
this way gets the trace's attributes but no agent.

Claim a worker when you can name its agent. Its place in the trace still
comes from its workflow call.

### After a trace ends

Keep your claim after the trace has ended. A thread's last turn often
finishes after the trace does, and the plugin exports a turn only when its
thread goes idle.

Set `trace.endedAt` once the trace has ended, by claiming the thread again. A
turn that starts after that time gets a trace of its own, outside yours.
Without `endedAt`, every later turn in the thread joins the finished trace.

## `report_trace`

Reports a trace's own structure.

Each call is a whole snapshot of the trace, and replaces the one before. Report
whenever the trace changes, and once more after it ends. The plugin sends
nothing while it handles the call: what a snapshot makes due goes out at the
plugin's next pass, within a minute or so.

Input:

```json
{
  "contract": 2,
  "trace": {
    "key": "run_42",
    "ended": true,
    "pipeline": "feature-dev",
    "attributes": { "example.run_id": "run_42" },
    "spans": [
      {
        "key": "root",
        "parentKey": null,
        "name": "example.run feature-dev",
        "op": "example.run",
        "start": 1800000000000,
        "end": 1800000400000,
        "attributes": { "example.state": "completed" }
      },
      {
        "key": "step-develop-1",
        "parentKey": "root",
        "name": "example.step develop#1",
        "op": "example.step",
        "start": 1800000100000,
        "end": 1800000300000,
        "workflowName": "example-run-42-develop-1"
      },
      {
        "key": "decision-1",
        "parentKey": "root",
        "name": "decide example/decider-1",
        "op": "gen_ai.decide",
        "kind": "client",
        "final": true,
        "start": 1800000050000,
        "end": 1800000050420,
        "attributes": {
          "gen_ai.operation.name": "decide",
          "gen_ai.request.model": "example/decider-1",
          "gen_ai.usage.input_tokens": 400,
          "gen_ai.usage.output_tokens": 20
        }
      },
      {
        "key": "verify-1",
        "parentKey": "step-develop-1",
        "name": "example.verify",
        "op": "example.verify",
        "start": 1800000310000,
        "end": 1800000310000,
        "status": "error",
        "errorType": "verify_failed"
      }
    ]
  }
}
```

Or, for a trace that no longer exists:

```json
{ "contract": 2, "deleted": { "key": "run_42" } }
```

Output:

```json
{ "contract": 2, "sending": true }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `ended` | yes | Whether the trace has ended. The plugin sends the spans not sent yet, and the root, once, after a snapshot says `true`. |
| `pipeline`, `attributes` | optional | As in the thread context; they apply to every span. |
| `spans[].key` | yes | Your id for the span, unique in the trace. Thread contexts and other spans refer to it. |
| `spans[].parentKey` | optional | The parent span's key. Missing or unknown means the root. |
| `spans[].name` | yes | The span's name. Keep it to a small set of values; put ids in attributes. |
| `spans[].op` | optional | The span's operation, such as `example.step` or `gen_ai.decide`. |
| `spans[].start`, `.end` | yes | The span's times. |
| `spans[].status` | optional | `ok` or `error`. |
| `spans[].errorType` | optional | A short, fixed reason for an error, such as `verify_failed`: up to 64 letters, digits, `_`, `.` and `-`, starting with a letter. Anything else is sent as `error`. |
| `spans[].errorMessage` | optional | Free text about the error. Kept and sent only as [content](#content), cut to 300 characters. |
| `spans[].kind` | optional | `client` for a call to a model, else `internal`. |
| `spans[].attributes` | optional | The span's attributes. |
| `spans[].content` | optional | Attributes that hold user or model text. See [Content](#content). |
| `spans[].workflowName`, `.workflowRunId` | optional | The bb Workflows run this span started, by the name its script declares or by its run id. See [Workflow runs](#workflow-runs). |
| `spans[].final` | optional | `true` when the span will not change again, so it can be sent before the trace ends. See [When the trace is sent](#when-the-trace-is-sent). |

### Limits

- At most 2,000 spans, refused with `invalid_input` past that.
- Times are milliseconds since the epoch, from 0 to 10,000,000,000,000; a
  time outside that range is refused with `invalid_input`.
- Keys are at most 200 characters; names, ops, the pipeline, `errorType`,
  `workflowName` and `workflowRunId` at most 1,000. Past that, the call is
  refused with `invalid_input`.
- At most 4 MB for the whole trace as sent, 128 KB for one span once checked
  (not counting its content and error message), and 192 KB for the trace's
  pipeline and attributes once checked; past any of them, the call is refused
  with `invalid`. The checks are the same whether content is captured or not.
- The plugin keeps at most 200 of your snapshots that no exported turn is in
  yet, and drops the oldest reported past that.
- While export is off (`sending: false`), the plugin keeps no snapshot. Report
  again after it is turned on; a provider that reports on every change does.
  A `deleted` report is always kept.

### The root

Exactly one span has the key `root` and no parent. Threads with
`"parent": null` hang under it. If a trace has no `root` span, the plugin
makes one that covers the other spans.

### When the trace is sent

The plugin looks at a trace once it has exported a turn of a thread in it,
then at each of its passes, about once a minute, and only when a newer
snapshot came in.

- Until the first snapshot comes, the trace's own spans wait.
- While the trace is open, it sends each span marked `"final": true` that it
  has not sent yet, once. Mark a span final only when nothing about it will
  change: Sentry keeps the first copy it gets. The root is never sent early,
  even when marked final, since it covers the whole trace.
- Once a snapshot says `ended`, it sends every span not sent yet, and the
  root, and is done with the trace. Later snapshots of it are ignored.
- A trace still open 30 days after it was first seen is sent as its last
  snapshot stands, with its root marked `bb.trace.state: "open"`. With no
  snapshot by then, its own spans are never sent.
- After a `deleted` report, it sends a root marked `bb.trace.state:
  "deleted"` for the turns it already sent into that trace.

A span sent early keeps its parent, even when the parent is sent later.

Mark a span final when it records something that happened, such as a model
call, a check or a choice. Spans whose times or state still move, such as a
step in progress, should wait for the end.

Thread turns are sent as they finish, before the trace's own spans. Until the
trace ends, it has no root in Sentry.

A snapshot is dropped a day after its trace was sent, or after 30 days when
no turn was ever sent into its trace.

### Workflow runs

The plugin builds a bb Workflows run's spans itself: the run, its phases, its
calls, and each worker's turns under its call. A provider only says where the
run hangs, by naming the workflow on the span that started it:

- `workflowName`, the name the workflow's script declares. Use this when you
  write the script yourself and give each one a unique name: you know the name
  before the run exists.
- `workflowRunId`, the run's id, when you know it.

You may learn which workflow a span started only after the workflow has run.
The plugin waits up to ten minutes after a workflow ends for a snapshot that
names it. After that it hangs the workflow run where the thread that started
it hangs.

When Workflows is disabled or removed, workers export as threads of their
own, and nothing waits for it. When it fails for a moment, a worker's turns
wait for it to answer again, for up to 30 minutes, and then go out on their
own.

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
  and `gen_ai.conversation.id`, in any case (`SENTRY.op` too);
- drops keys for user or model text outside `content`, in any case:
  `gen_ai.input.*`, `gen_ai.output.*`, `gen_ai.tool.call.*`, `gen_ai.prompt*`,
  `gen_ai.completion*`, `gen_ai.system_instructions`,
  `gen_ai.request.messages`, `gen_ai.request.available_tools`,
  `gen_ai.response.text`, `gen_ai.response.tool_calls`, `gen_ai.tool.input`,
  `gen_ai.tool.output`, `gen_ai.tool.description` and
  `gen_ai.tool.definitions`;
- drops keys for one model call's usage and cost from trace and thread
  attributes, which land on every span;
- lets its own attributes win over a provider's with the same key.

Prefix your attributes with your plugin's name, such as `example.run_id`.

## Content

The plugin has a `captureContent` setting, off by default. It decides whether
prompts, replies, tool arguments and outputs leave the machine. You are not
told its value; send content anyway, and the plugin decides.

- Put text in `spans[].content` and `spans[].errorMessage`, never in `name`
  or `attributes`.
- While `captureContent` is off, those two fields are dropped as the snapshot
  comes in, and are never stored or sent.
- While it is on, they are scrubbed for secrets and capped as they come in:
  8,000 characters per content value, and 48 KB of content per span. Values
  past the 48 KB are dropped; the span is kept. They are stored that way until
  sent. If `captureContent` is turned off before then, they are dropped when
  sending.
- Send only content you are comfortable having stored on this machine until
  it is sent. Scrub the text yourself first if you have a scrubber.

## Ids

Trace and span ids are hashes of the provider's plugin id, the trace key and
the span key. So a thread's turns and the trace's own spans link up without
talking to each other, and a restart cannot fork a trace. Keep `trace.key` and
span keys stable for the life of a trace.
