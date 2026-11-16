import type { CaptureCreate } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import { configFrom } from "./config";
import { createOverturnClient, OverturnError } from "./overturn";

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const captureBody: CaptureCreate = {
  source: "gorgias",
  externalId: "gr:1",
  agent: "support-reply",
  context: [],
  draft: { text: "a" },
  sent: { text: "b" },
};

const env = {
  GORGIAS_DOMAIN: "acme",
  GORGIAS_EMAIL: "api@acme.com",
  GORGIAS_API_KEY: "gk",
  OVERTURN_API_KEY: "ov_k",
  APP_URL: "https://app.overturn.test",
  WIDGET_TOKEN: "w_secret",
  AGENT: "support-reply",
  REASON_PACK: "support",
  DECISION_FIELDS: "status:status",
  ORDER_FIELDS: "4509:order_id",
  MIN_DRAFT_CHARS: "60",
  SCOPE_TAG: "ai_drafted",
};

describe("the app's environment", () => {
  it("carries the same choices as the Zendesk app's settings", () => {
    const config = configFrom(env);
    expect(config).toMatchObject({
      port: 3000,
      gorgias: { domain: "acme", email: "api@acme.com", apiKey: "gk" },
      overturn: { apiKey: "ov_k", baseUrl: "https://api.overturn.run" },
      settings: {
        appUrl: "https://app.overturn.test",
        widgetToken: "w_secret",
        agent: "support-reply",
        reasonPack: "support",
        minDraftChars: 60,
        scopeTag: "ai_drafted",
        decisionFields: [{ id: "status", label: "status" }],
        orderFields: [{ id: "4509", label: "order_id" }],
      },
    });
    expect(config.settings.requireReason).toBe(true);
  });

  it("reads a port, and says what is missing", () => {
    expect(configFrom({ ...env, PORT: "8080" }).port).toBe(8080);
    expect(configFrom({ ...env, PORT: "nonsense" }).port).toBe(3000);
    expect(() => configFrom({ ...env, GORGIAS_DOMAIN: "" })).toThrow(/GORGIAS_DOMAIN/);
    expect(() => configFrom({ ...env, OVERTURN_API_KEY: undefined })).toThrow(/OVERTURN_API_KEY/);
  });
});

describe("the Overturn client", () => {
  it("finds the run a drafting agent recorded for the Gorgias ticket", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createOverturnClient({ baseUrl: "https://api.overturn.run/", apiKey: "ov_k" }, (async (
      url: string,
      init: RequestInit,
    ) => {
      calls.push({ url, init });
      return json({
        items: [{ id: "run-1", agent: "support-reply", output: "Hi Dana", endedAt: "2026-10-01T12:00:00Z" }],
      });
    }) as typeof fetch);

    const run = await client.lastRun("gr:48213", "support-reply");
    expect(calls[0]?.url).toBe(
      "https://api.overturn.run/v1/runs?externalId=gr%3A48213&agent=support-reply&limit=1",
    );
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.Authorization).toBe("Bearer ov_k");
    expect(run).toEqual({
      id: "run-1",
      agent: "support-reply",
      output: "Hi Dana",
      model: null,
      endedAt: "2026-10-01T12:00:00Z",
    });
  });

  it("has no run to offer when the lookup fails or comes back empty", async () => {
    const client = createOverturnClient({ baseUrl: "https://api.overturn.run", apiKey: "ov_k" }, (async () =>
      json({ items: [] })) as typeof fetch);
    expect(await client.lastRun("gr:1", "a")).toBeNull();
    const failing = createOverturnClient(
      { baseUrl: "https://api.overturn.run", apiKey: "ov_k" },
      (async () => new Response("", { status: 500 })) as typeof fetch,
    );
    expect(await failing.lastRun("gr:1", "a")).toBeNull();
  });

  it("posts the capture and reads back what the panel repeats", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createOverturnClient({ baseUrl: "https://api.overturn.run", apiKey: "ov_k" }, (async (
      url: string,
      init: RequestInit,
    ) => {
      calls.push({ url, init });
      return json({
        kind: "edit",
        changed: true,
        changedFields: [],
        deduplicated: false,
        case: { title: "Order 4509 ships Monday" },
      });
    }) as typeof fetch);

    const result = await client.capture(captureBody);
    expect(calls[0]?.url).toBe("https://api.overturn.run/v1/capture");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ source: "gorgias", externalId: "gr:1" });
    expect(result).toEqual({
      kind: "edit",
      changed: true,
      deduplicated: false,
      case: { title: "Order 4509 ships Monday" },
    });
  });

  it("throws with the status when the API refuses the capture, so the app can retry it", async () => {
    const client = createOverturnClient(
      { baseUrl: "https://api.overturn.run", apiKey: "ov_k" },
      (async () => new Response(JSON.stringify({ message: "nope" }), { status: 422 })) as typeof fetch,
    );
    await expect(client.capture(captureBody)).rejects.toBeInstanceOf(OverturnError);
    await expect(client.capture(captureBody)).rejects.toThrow(/422/);
  });
});
