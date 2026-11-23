/**
 * bb-plugin-sentry-traces: sends agent traces from bb threads to Sentry Agent
 * Monitoring over Sentry's direct OTLP endpoint.
 *
 * Nothing leaves the machine until a DSN is set and `enabled` is turned on.
 * Message content is a second, separate opt-in (`captureContent`). There is no
 * Sentry SDK here and no global instrumentation: plugin code shares bb's
 * server process, so this only builds OTLP/JSON and posts it with `fetch`.
 */
import type { BbPluginApi, StandardSchemaV1 } from "@get-bb/plugin-sdk";
import { CLI_NAME, registerCli } from "./cli.js";
import { Exporter } from "./export/exporter.js";
import { sends } from "./export/settings.js";
import { type ExportSettings } from "./export/types.js";
import { registerProviderRpc } from "./integrations/providers/rpc.js";
import { parseDsn, type Fetch } from "./sentry.js";
import { toThreadInfo } from "./thread.js";

/** How often failed exports are retried and ended traces and workflow runs are sent. */
const TICK_MS = 60_000;

export interface PluginOptions {
  /** Test seams. */
  fetch?: Fetch;
  now?: () => number;
}

/**
 * A text setting's check: at most `max` characters. Written out rather than
 * taken from zod, whose failure type does not fit the SDK's `path?` under
 * exactOptionalPropertyTypes.
 */
function maxLength(max: number, message: string): StandardSchemaV1<string, string> {
  return {
    "~standard": {
      version: 1,
      vendor: "bb-sentry-traces",
      validate: (value) =>
        typeof value === "string" && value.length <= max ? { value } : { issues: [{ message }] },
    },
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createPlugin(options: PluginOptions = {}) {
  return async function plugin(bb: BbPluginApi) {
    const settings = bb.settings.define({
      dsn: {
        type: "string",
        label: "Sentry DSN (Project settings > Client Keys)",
        secret: true,
      },
      enabled: {
        type: "boolean",
        label: "Send traces to Sentry",
        default: false,
      },
      captureContent: {
        type: "boolean",
        label: "Also send prompts, replies, tool arguments and outputs",
        default: false,
      },
      environment: {
        type: "string",
        label: "Environment label, such as dev or laptop",
        default: "",
        experimental_schema: maxLength(64, "Use at most 64 characters"),
      },
    });

    const readSettings = async (): Promise<ExportSettings> => {
      const values = await settings.get();
      return {
        dsn: typeof values['dsn'] === "string" ? values['dsn'] : undefined,
        enabled: values['enabled'],
        captureContent: values['captureContent'],
        environment: values['environment'],
      };
    };

    // bb clears this notice only when the plugin loads again, so it says how.
    // Export itself reads the settings each time and needs no reload.
    const checkDsn = (raw: string | undefined) => {
      const dsn = parseDsn(raw);
      if (dsn.ok) return;
      bb.status.needsConfiguration(
        `${dsn.reason} Set one with \`bb plugin config ${CLI_NAME} set dsn <dsn>\`, ` +
          `turn export on with \`bb plugin config ${CLI_NAME} set enabled true\`, ` +
          `then run \`bb plugin reload ${bb.pluginId}\` to clear this notice.`,
      );
    };
    checkDsn((await readSettings()).dsn);

    const exporter = new Exporter({
      bb,
      settings: readSettings,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    // Waits a few seconds for an export still running to save what it sent.
    bb.onDispose(() => exporter.dispose());

    // Trace providers push where their threads belong and what their traces
    // hold; the export reads what they stored.
    registerProviderRpc(bb, {
      store: exporter.providers,
      sending: async () => {
        const values = await readSettings();
        return { sending: sends(values), captureContent: values.captureContent };
      },
    });

    settings.onChange((next, previous) => {
      if (next['dsn'] !== previous['dsn']) checkDsn(typeof next['dsn'] === "string" ? next['dsn'] : undefined);
      // Turned on, or given a DSN, after it could not send: what finishes
      // from now on is sent, not what finished in between. Loading the
      // plugin, as at a restart, is not turning it on.
      if (sends(next) && !sends(previous)) void exporter.noteSendingOn();
    });

    // A turn that just finished, or a thread that just failed: send what is new.
    // Handlers return at once and never throw; the export reports its own failures.
    for (const event of ["thread.idle", "thread.failed"] as const) {
      bb.events.on(event, ({ thread }) => {
        void exporter.enqueue(toThreadInfo(thread));
      });
    }
    bb.events.on("thread.active", ({ thread }) => {
      void exporter.noteActive(thread.id);
    });
    bb.events.on("thread.deleted", ({ thread }) => {
      void exporter.forget(thread.id);
    });

    bb.background.service("export-retry", {
      async start(signal) {
        // The first pass runs at load, picking up retries left by a restart.
        while (!signal.aborted) {
          await exporter.tick();
          await sleep(TICK_MS, signal);
        }
      },
    });

    registerCli(bb, {
      exporter,
      settings: readSettings,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  };
}

export default createPlugin();
