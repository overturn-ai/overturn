import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, settingsFrom } from "./capture";
import { buildIntegration, buildWidget, installGorgiasApp } from "./install";

function checkedIn(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../app/${name}`, import.meta.url), "utf8"));
}

const creds = { domain: "acme", email: "api@acme.com", apiKey: "gk" };
const authorization = `Basic ${Buffer.from("api@acme.com:gk").toString("base64")}`;

describe("the payloads that go into a helpdesk", () => {
  it("leaves {{ticket.id}} for Gorgias to substitute, and carries the install's token", () => {
    expect(buildIntegration({ appUrl: "https://app.overturn.test/", token: "t" }).http.url).toBe(
      "https://app.overturn.test/gorgias/widget?ticket_id={{ticket.id}}&token=t",
    );
    expect(buildIntegration({ appUrl: "https://app.overturn.run" }).http.url).toBe(
      "https://app.overturn.run/gorgias/widget?ticket_id={{ticket.id}}",
    );
  });

  it("calls back on the three ticket events that matter", () => {
    expect(buildIntegration({ appUrl: "https://app.overturn.run" }).http.triggers).toEqual({
      "ticket-created": true,
      "ticket-updated": true,
      "ticket-message-created": true,
    });
  });

  it("keeps app/integration.json and app/widget.json identical to what is posted", () => {
    expect(checkedIn("integration.json")).toEqual(
      buildIntegration({ appUrl: "https://app.overturn.run", token: null }),
    );
    expect(checkedIn("widget.json")).toEqual(buildWidget(DEFAULT_SETTINGS, 0));
  });

  it("registers the integration first, then the widget that reads its response", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        auth: (init.headers as Record<string, string>).Authorization ?? "",
      });
      return new Response(JSON.stringify({ id: calls.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const result = await installGorgiasApp({
      creds,
      appUrl: "https://app.overturn.test",
      settings: settingsFrom({ reason_pack: "support", scope_tag: "ai_drafted" }),
      token: "t",
      fetchImpl,
    });

    expect(result).toEqual({ integrationId: 1, widgetId: 2 });
    expect(calls[0]?.url).toBe("https://acme.gorgias.com/api/integrations");
    expect(calls[0]?.auth).toBe(authorization);
    expect(calls[0]?.body).toMatchObject({ type: "http" });
    expect(calls[1]?.url).toBe("https://acme.gorgias.com/api/widgets");
    expect(calls[1]?.auth).toBe(authorization);
    expect(calls[1]?.body).toMatchObject({ context: "ticket", type: "http", integration_id: 1 });
  });

  it("says which status Gorgias refused with", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as typeof fetch;
    await expect(
      installGorgiasApp({
        creds,
        appUrl: "https://app.overturn.test",
        settings: DEFAULT_SETTINGS,
        fetchImpl,
      }),
    ).rejects.toThrow(/403/);
  });
});
