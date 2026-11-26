import { widgetTemplate } from "./widget";

export interface InstallOptions {
  /** The public base URL of this app, e.g. `https://overturn-gorgias.example.com`. */
  appBaseUrl: string;
  /** The key the app checks on the integration's requests. */
  appKey: string;
}

/** The integration that points Gorgias at this app. */
export interface IntegrationPayload {
  name: string;
  description: string;
  type: "http";
  http: {
    url: string;
    method: "POST";
    headers: Record<string, string>;
    triggers: {
      "ticket-created": boolean;
      "ticket-message-created": boolean;
      "ticket-updated": boolean;
    };
    request_content_type: "application/json";
    response_content_type: "application/json";
  };
}

/**
 * The HTTP integration.
 *
 * Gorgias substitutes `{{ticket.id}}` in the URL, so every trigger names the ticket it is
 * about. The body carries the event payload as well; the app reads the id from the query
 * first and from the body second.
 */
export function integrationPayload(options: InstallOptions): IntegrationPayload {
  const url = new URL("/gorgias/events", options.appBaseUrl);
  url.searchParams.set("ticket_id", "{{ticket.id}}");
  return {
    name: "Overturn",
    description: "Captures what the AI drafted, what the agent sent, and why.",
    type: "http",
    http: {
      url: url.toString(),
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Overturn-Key": options.appKey,
      },
      triggers: {
        "ticket-created": true,
        "ticket-message-created": true,
        "ticket-updated": true,
      },
      request_content_type: "application/json",
      response_content_type: "application/json",
    },
  };
}

/** The widget that renders the card in the ticket sidebar. */
export interface WidgetPayload {
  context: "ticket";
  type: "http";
  integration_id: number;
  template: ReturnType<typeof widgetTemplate>;
}

export function widgetPayload(integrationId: number): WidgetPayload {
  return {
    context: "ticket",
    type: "http",
    integration_id: integrationId,
    template: widgetTemplate(),
  };
}

export interface InstallResult {
  integrationId: number;
  widgetId: number;
}

/**
 * Registers the integration and the widget in a Gorgias account.
 *
 * Needs the account's REST API details (the base API URL, the API username and the API key)
 * and the public URL this app is reachable at. It is the one step that needs a live account;
 * everything else in this package is covered by the unit tests.
 */
export async function installGorgiasApp(
  options: InstallOptions & { baseUrl: string; apiUser: string; apiKey: string; fetch?: typeof fetch },
): Promise<InstallResult> {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const headers = {
    Authorization: `Basic ${Buffer.from(`${options.apiUser}:${options.apiKey}`).toString("base64")}`,
    "Content-Type": "application/json",
  };
  const integrationResponse = await doFetch(`${base}/integrations`, {
    method: "POST",
    headers,
    body: JSON.stringify(integrationPayload(options)),
  });
  if (!integrationResponse.ok) {
    throw new Error(`Gorgias answered ${integrationResponse.status} for the integration`);
  }
  const integration = (await integrationResponse.json()) as { id?: number };
  const integrationId = integration.id;
  if (typeof integrationId !== "number") throw new Error("Gorgias did not return an integration id");
  const widgetResponse = await doFetch(`${base}/widgets`, {
    method: "POST",
    headers,
    body: JSON.stringify(widgetPayload(integrationId)),
  });
  if (!widgetResponse.ok) {
    throw new Error(`Gorgias answered ${widgetResponse.status} for the widget`);
  }
  const widget = (await widgetResponse.json()) as { id?: number };
  const widgetId = widget.id;
  if (typeof widgetId !== "number") throw new Error("Gorgias did not return a widget id");
  return { integrationId, widgetId };
}
