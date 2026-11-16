import type { AppSettings } from "./capture";
import { type GorgiasCredentials, GorgiasError, gorgiasBase } from "./gorgias";
import { buildWidgetTemplate, WIDGET_NAME, type WidgetDefinition } from "./widget";

export { installConfigFrom } from "./config";

/**
 * The HTTP integration Gorgias calls when a ticket is created, updated or gets a message. Its
 * response is what the sidebar widget renders: one URL does the read, the checkpoint and the render.
 */
export interface IntegrationDefinition {
  name: string;
  description: string;
  type: "http";
  http: {
    url: string;
    method: "GET";
    headers: Record<string, string>;
    triggers: Record<string, boolean>;
    request_content_type: "application/json";
    response_content_type: "application/json";
  };
}

/** `{{ticket.id}}` must stay literal: Gorgias substitutes it when the trigger fires. */
export function integrationUrl(appUrl: string, token: string | null): string {
  const base = appUrl.replace(/\/+$/, "");
  const auth = token ? `&token=${encodeURIComponent(token)}` : "";
  return `${base}/gorgias/widget?ticket_id={{ticket.id}}${auth}`;
}

export function buildIntegration(input: { appUrl: string; token?: string | null }): IntegrationDefinition {
  return {
    name: WIDGET_NAME,
    description: "Files what the AI drafted, what the agent sent and why, as a replayable case.",
    type: "http",
    http: {
      url: integrationUrl(input.appUrl, input.token ?? null),
      method: "GET",
      headers: { Accept: "application/json" },
      triggers: {
        "ticket-created": true,
        "ticket-updated": true,
        "ticket-message-created": true,
      },
      request_content_type: "application/json",
      response_content_type: "application/json",
    },
  };
}

export interface GorgiasWidgetDefinition extends WidgetDefinition {
  integration_id: number;
}

export function buildWidget(settings: AppSettings, integrationId: number): GorgiasWidgetDefinition {
  return { ...buildWidgetTemplate(settings), integration_id: integrationId };
}

export interface InstallResult {
  integrationId: number;
  widgetId: number;
}

interface Created {
  id?: unknown;
}

async function post(
  url: string,
  authorization: string,
  payload: unknown,
  fetchImpl: typeof fetch,
): Promise<number> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: authorization, "content-type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new GorgiasError(`Gorgias returned ${res.status} for ${url}`, res.status);
  const created = (await res.json()) as Created | null;
  if (typeof created?.id !== "number") {
    throw new GorgiasError(`Gorgias did not return an id for ${url}`, 0);
  }
  return created.id;
}

/**
 * Registers the app in a helpdesk: the integration first (Gorgias calls it), then the widget that
 * reads its response. Both are created with the account's own REST credentials, which stay there.
 */
export async function installGorgiasApp(input: {
  creds: GorgiasCredentials;
  appUrl: string;
  settings: AppSettings;
  token?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<InstallResult> {
  const base = gorgiasBase(input.creds.domain);
  const authorization = `Basic ${Buffer.from(`${input.creds.email}:${input.creds.apiKey}`, "utf8").toString(
    "base64",
  )}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const integrationId = await post(
    `${base}/api/integrations`,
    authorization,
    buildIntegration({ appUrl: input.appUrl, token: input.token ?? null }),
    fetchImpl,
  );
  const widgetId = await post(
    `${base}/api/widgets`,
    authorization,
    buildWidget(input.settings, integrationId),
    fetchImpl,
  );
  return { integrationId, widgetId };
}
