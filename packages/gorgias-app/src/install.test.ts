import { describe, expect, it } from "vitest";
import { installGorgiasApp, integrationPayload, widgetPayload } from "./install";

const options = { appBaseUrl: "https://app.example.com", appKey: "secret" };

describe("integrationPayload", () => {
  it("points Gorgias at the app with the ticket in the url", () => {
    const payload = integrationPayload(options);
    expect(payload.type).toBe("http");
    expect(payload.http.method).toBe("POST");
    expect(payload.http.url).toContain("https://app.example.com/gorgias/events");
    expect(payload.http.url).toContain("ticket_id=%7B%7Bticket.id%7D%7D");
    expect(payload.http.headers["X-Overturn-Key"]).toBe("secret");
  });

  it("fires on every ticket event", () => {
    const payload = integrationPayload(options);
    expect(payload.http.triggers).toEqual({
      "ticket-created": true,
      "ticket-message-created": true,
      "ticket-updated": true,
    });
  });
});

describe("widgetPayload", () => {
  it("is a ticket widget bound to the integration", () => {
    const payload = widgetPayload(123);
    expect(payload.context).toBe("ticket");
    expect(payload.type).toBe("http");
    expect(payload.integration_id).toBe(123);
    expect(payload.template.type).toBe("wrapper");
  });
});

describe("installGorgiasApp", () => {
  it("registers the integration and then the widget", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      const body = String(url).endsWith("/integrations") ? { id: 7 } : { id: 9 };
      return new Response(JSON.stringify(body), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await installGorgiasApp({
      ...options,
      baseUrl: "https://shop.gorgias.com/api",
      apiUser: "admin@example.com",
      apiKey: "key",
      fetch: fakeFetch,
    });

    expect(result).toEqual({ integrationId: 7, widgetId: 9 });
    expect(calls).toEqual([
      "https://shop.gorgias.com/api/integrations",
      "https://shop.gorgias.com/api/widgets",
    ]);
  });

  it("says so when Gorgias refuses", async () => {
    const fakeFetch = (async () => new Response("nope", { status: 400 })) as unknown as typeof fetch;
    await expect(
      installGorgiasApp({
        ...options,
        baseUrl: "https://shop.gorgias.com/api",
        apiUser: "admin@example.com",
        apiKey: "key",
        fetch: fakeFetch,
      }),
    ).rejects.toThrow(/Gorgias answered 400/);
  });
});
