/**
 * The two RPC methods trace providers call: `report_threads` and
 * `report_trace`. Only another loaded plugin may call them, and its plugin id
 * is the provider id, so a provider can only change what it reported itself.
 *
 * The handlers check and store what they are given, and return. They send
 * nothing: the export's next tick does, so a provider is never held up by
 * Sentry, and a report never fails because Sentry did.
 */
import {
  defineRpcContract,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
  type ExperimentalPluginRpcCaller,
  type StandardSchemaV1,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  claimContext,
  reportThreadsInput,
  reportThreadsOutput,
  reportTraceInput,
  reportTraceOutput,
  storedTrace,
  type ProviderTrace,
} from "./schema.js";
import { SnapshotTooLarge, type ProviderStore } from "./store.js";
import { CONTRACT_VERSION } from "./types.js";

/** A snapshot larger than this, as sent, is refused: it would fill storage, and Sentry would refuse it too. */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;

const DOCS = "See docs/trace-provider-contract.md in the Sentry Traces plugin.";

/** A call that names a contract version other than this plugin's, whatever else it holds. */
function otherContract(value: unknown): boolean {
  return typeof value === "object" && value !== null && "contract" in value && value.contract !== CONTRACT_VERSION;
}

/**
 * A zod schema as the SDK's Standard Schema, with the JSON Schema export
 * discovery needs. Written out rather than passed as is: zod's failure type
 * does not fit the SDK's under exactOptionalPropertyTypes.
 *
 * With `anyContract`, a call on another version passes whatever its shape,
 * so the handler refuses it naming the version this plugin speaks, rather
 * than as malformed. The handler checks the version before it reads the rest.
 */
function standard<T>(schema: z.ZodType<T>, options: { anyContract?: boolean } = {}): StandardSchemaV1<T, T> {
  const json = (io: "input" | "output") => () =>
    z.toJSONSchema(schema, { io, target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
  return {
    "~standard": {
      version: 1,
      vendor: "zod",
      validate: (value) => {
        if (options.anyContract && otherContract(value)) return { value: value as T };
        const result = schema.safeParse(value);
        if (result.success) return { value: result.data };
        return { issues: result.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
      },
      jsonSchema: { input: json("input"), output: json("output") },
    },
  };
}

const traceProviderContract = defineRpcContract({
  report_threads: {
    experimental_description:
      "Claim threads for a trace of yours, or clear your claim with a null context. " +
      "Claim a thread before its first turn ends: a turn is placed when it is exported.",
    input: standard(reportThreadsInput, { anyContract: true }),
    output: standard(reportThreadsOutput),
  },
  report_trace: {
    experimental_description:
      "Report a trace's own spans as a whole snapshot, replacing the last one, or say it was deleted. " +
      "Report whenever it changes, and once after it ends.",
    input: standard(reportTraceInput, { anyContract: true }),
    output: standard(reportTraceOutput),
  },
});

export interface ProviderRpcDeps {
  store: ProviderStore;
  /** Whether the export still needs a trace's snapshot, so it is not trimmed. */
  tracked: (provider: string, traceKey: string) => Promise<boolean>;
  /** Whether export is on with a usable DSN, and whether content is captured. */
  sending: () => Promise<{ sending: boolean; captureContent: boolean }>;
}

function refuse(code: "forbidden" | "invalid", message: string): never {
  throw new experimental_PluginRpcRefusal({ code, message });
}

/**
 * The provider a call comes from: the plugin that made it. The app, the CLI
 * and agents are not providers, and this plugin cannot report to itself. A
 * call on another version is refused here, before anything else of it is read.
 */
function providerOf(caller: ExperimentalPluginRpcCaller, self: string, contract: unknown): string {
  if (caller.kind !== "plugin") refuse("forbidden", `Only another bb plugin can report traces. ${DOCS}`);
  if (caller.pluginId === self) refuse("forbidden", "This plugin does not report to itself.");
  if (contract !== CONTRACT_VERSION) {
    refuse(
      "invalid",
      `This plugin speaks trace provider contract ${CONTRACT_VERSION}, not ${JSON.stringify(contract)}. ${DOCS}`,
    );
  }
  return caller.pluginId;
}

/** Stores a snapshot, refusing one too large to store. */
async function saveTrace(store: ProviderStore, provider: string, trace: ProviderTrace): Promise<void> {
  try {
    await store.saveSnapshot(provider, trace);
  } catch (cause) {
    if (cause instanceof SnapshotTooLarge) refuse("invalid", `${cause.message}. ${DOCS}`);
    throw cause;
  }
}

export function registerProviderRpc(bb: Pick<BbPluginApi, "rpc" | "pluginId">, deps: ProviderRpcDeps): void {
  bb.rpc.register(
    traceProviderContract,
    {
      async report_threads(input, { experimental_caller }) {
        const provider = providerOf(experimental_caller, bb.pluginId, input.contract);
        const results: Record<string, "ok" | "conflict" | "invalid" | "limit"> = {};
        for (const { threadId, context } of input.threads) {
          results[threadId] = await deps.store.setClaim(
            threadId,
            provider,
            context ? claimContext(provider, context) : null,
          );
        }
        await deps.store.noteReport(provider);
        const { sending } = await deps.sending();
        return { contract: CONTRACT_VERSION, sending, results };
      },

      async report_trace(input, { experimental_caller }) {
        const provider = providerOf(experimental_caller, bb.pluginId, input.contract);
        const { trace, deleted } = input;
        // Checked whether or not export is on, so a provider learns of it the same way.
        if (trace && Buffer.byteLength(JSON.stringify(trace), "utf8") > MAX_SNAPSHOT_BYTES) {
          refuse("invalid", `The trace is larger than ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB. ${DOCS}`);
        }
        const { sending, captureContent } = await deps.sending();
        if (deleted) await deps.store.saveDeleted(provider, deleted.key);
        // Nothing is sent from a trace while export is off, so nothing of it is kept.
        else if (trace && !sending) await deps.store.deleteSnapshot(provider, trace.key);
        else if (trace) await saveTrace(deps.store, provider, storedTrace(trace, captureContent));
        await deps.store.trimSnapshots(provider, (traceKey) => deps.tracked(provider, traceKey));
        await deps.store.noteReport(provider);
        return { contract: CONTRACT_VERSION, sending };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Trace provider contract 2: group bb threads into one trace of yours and describe its spans, " +
        "for export to Sentry. " +
        DOCS,
    },
  );
}
