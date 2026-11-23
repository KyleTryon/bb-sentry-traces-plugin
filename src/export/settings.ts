/** Reads the export settings into what the export needs: the Sentry target and the resource. */
import { type ResourceInfo } from "../core/otlp.js";
import { type ExportContext, type ExportSettings } from "./types.js";
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

/** Whether these setting values send anything: export turned on, with a DSN that reads. */
export function sends(values: { enabled?: unknown; dsn?: unknown }): boolean {
  return values.enabled === true && parseDsn(typeof values.dsn === "string" ? values.dsn : undefined).ok;
}

/**
 * The settings as they are now, while they still send to `target`. Null once
 * export was turned off, the plugin unloaded or the DSN changed: a long export
 * stops there rather than send on after it, or to a project it no longer should.
 */
export async function stillSending(ctx: ExportContext, target: SentryTarget): Promise<ExportSettings | null> {
  if (ctx.disposed) return null;
  const settings = await ctx.settings();
  if (!settings.enabled) return null;
  const current = targetOf(settings);
  if ("reason" in current) return null;
  const same = current.target.endpoint === target.endpoint && current.target.authHeader === target.authHeader;
  return same ? settings : null;
}
