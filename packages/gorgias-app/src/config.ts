import { type AppSettings, settingsFrom } from "./capture";
import type { GorgiasCredentials } from "./gorgias";
import type { OverturnCredentials } from "./overturn";

export interface Config {
  settings: AppSettings;
  gorgias: GorgiasCredentials;
  overturn: OverturnCredentials;
  port: number;
}

export interface InstallConfig {
  settings: AppSettings;
  gorgias: GorgiasCredentials;
  /** Where this app is served: the installer puts it in the integration URL. */
  appUrl: string;
  /** The shared secret that URL carries back on every call. */
  token: string | null;
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is not set`);
  return value;
}

function gorgiasCredentials(env: Record<string, string | undefined>): GorgiasCredentials {
  return {
    domain: required(env, "GORGIAS_DOMAIN"),
    email: required(env, "GORGIAS_EMAIL"),
    apiKey: required(env, "GORGIAS_API_KEY"),
  };
}

/**
 * The keys the app reads are the same the Zendesk app's settings use (`reason_pack`,
 * `require_reason`, `decision_fields`), so a project's choices travel between the two.
 */
export function appSettingsFromEnv(env: Record<string, string | undefined>): AppSettings {
  return settingsFrom({
    overturn_base_url: env.OVERTURN_BASE_URL,
    app_url: env.APP_URL ?? env.PUBLIC_APP_URL,
    widget_token: env.WIDGET_TOKEN,
    agent: env.AGENT,
    reason_pack: env.REASON_PACK,
    require_reason: env.REQUIRE_REASON,
    capture_internal_notes: env.CAPTURE_INTERNAL_NOTES,
    decision_fields: env.DECISION_FIELDS,
    order_fields: env.ORDER_FIELDS,
    min_draft_chars: env.MIN_DRAFT_CHARS,
    scope_tag: env.SCOPE_TAG,
  });
}

/** The environment of a self-hosted install: the app Gorgias calls, and the API it files to. */
export function configFrom(env: Record<string, string | undefined>): Config {
  const settings = appSettingsFromEnv(env);
  const port = Number(env.PORT ?? 3000);
  return {
    settings,
    gorgias: gorgiasCredentials(env),
    overturn: {
      baseUrl: settings.baseUrl,
      apiKey: required(env, "OVERTURN_API_KEY"),
    },
    port: Number.isFinite(port) && port > 0 ? port : 3000,
  };
}

/** What `scripts/install.mjs` needs to register the app in a helpdesk: no Overturn key required. */
export function installConfigFrom(env: Record<string, string | undefined>): InstallConfig {
  const settings = appSettingsFromEnv(env);
  const appUrl = settings.appUrl || required(env, "APP_URL");
  return {
    settings: { ...settings, appUrl },
    gorgias: gorgiasCredentials(env),
    appUrl,
    token: settings.widgetToken,
  };
}
