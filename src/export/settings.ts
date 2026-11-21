/** Reads the export settings into what the export needs: the Sentry target and the resource. */
import { type ResourceInfo } from "../core/otlp.js";
import { type ExportSettings } from "./types.js";
import { type SentryTarget, parseDsn } from "../sentry.js";
import { VERSION } from "../version.js";

export function resourceOf(settings: ExportSettings): ResourceInfo {
  return { pluginVersion: VERSION, environment: settings.environment.trim() || null };
}

/** The Sentry target, or why there is none. Never includes the key in a message. */
export function targetOf(settings: ExportSettings): { target: SentryTarget } | { reason: string } {
  const parsed = parseDsn(settings.dsn);
  return parsed.ok ? { target: parsed.target } : { reason: parsed.reason };
}
