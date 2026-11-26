import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import type { DraftState, TicketSnapshot } from "./capture";
import { settingsFrom } from "./capture";
import type { GorgiasClient } from "./gorgias-client";
import type { OverturnClient } from "./overturn-client";
import { type AppRequest, createApp, ticketIdFrom } from "./server";

const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const DRAFT_TEXT =
  "Hi Ada, I looked into order 8123 and it left our warehouse on Monday. It should arrive Thursday.";
const CHANGED_TEXT = "Your order 8123 shipped on Monday and should arrive Thursday.";

const draft = (): DraftState => ({
  text: DRAFT_TEXT,
  origin: "recorded",
  runId: "6f2b2a44-6e0f-4b1f-9b8a-0f1e2d3c4b5a",
  model: null,
  at: at("2026-11-16T09:30:00Z"),
});

const ticket = (over: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  id: 48213,
  subject: "Where is my order?",
  customerEmail: "ada@example.com",
  customerName: "Ada Lovelace",
  assigneeEmail: "agent@example.com",
  messages: [
    {
      id: 1,
      bodyText: "My order 8123 has not arrived.",
      fromAgent: false,
      authorEmail: "ada@example.com",
      createdAt: "2026-11-16T09:00:00",
    },
    {
      id: 2,
      bodyText: CHANGED_TEXT,
      fromAgent: true,
      authorEmail: "agent@example.com",
      createdAt: "2026-11-16T10:00:00",
    },
  ],
  tags: [],
  orders: [{ id: 8123, provider: "shopify", total: "49.90", currency: "USD", itemCount: 2 }],
  fields: {},
  url: null,
  ...over,
});

const captureResult = (): CaptureResult => ({
  runId: "6f2b2a44-6e0f-4b1f-9b8a-0f1e2d3c4b5a",
  stepId: "step-1",
  kind: "edit",
  changed: true,
  changedFields: [],
  correction: {
    id: "correction-1",
    projectId: "project-1",
    runId: "6f2b2a44-6e0f-4b1f-9b8a-0f1e2d3c4b5a",
    stepId: "step-1",
    kind: "edit",
    correctedOutput: null,
    note: null,
    reasonCode: null,
    actor: "agent@example.com",
    source: "capture",
    createdAt: "2026-11-16T10:00:00.000Z",
  },
  case: null,
  deduplicated: false,
});

function overturnFake(options: { draft?: DraftState | null; fail?: boolean } = {}) {
  const captures: CaptureCreate[] = [];
  const client: OverturnClient = {
    async findDraft() {
      return options.draft === undefined ? draft() : options.draft;
    },
    async capture(body: CaptureCreate) {
      captures.push(body);
      if (options.fail) throw new Error("overturn is down");
      return captureResult();
    },
  };
  return { client, captures };
}

function gorgiasFake(snapshot: TicketSnapshot, fail = false) {
  const client: GorgiasClient = {
    async getTicket() {
      if (fail) throw new Error("gorgias is down");
      return snapshot;
    },
  };
  return client;
}

function appWith(
  options: {
    ticket?: TicketSnapshot;
    overturn?: ReturnType<typeof overturnFake>;
    gorgiasFail?: boolean;
    appKey?: string | null;
  } = {},
) {
  const overturn = options.overturn ?? overturnFake();
  const app = createApp({
    settings: settingsFrom({}),
    overturn: overturn.client,
    gorgias: gorgiasFake(options.ticket ?? ticket(), options.gorgiasFail),
    appBaseUrl: "https://app.example.com",
    appKey: options.appKey ?? null,
    now: () => at("2026-11-16T10:05:00Z"),
  });
  return { app, overturn };
}

const request = (over: Partial<AppRequest> = {}): AppRequest => ({
  method: "POST",
  path: "/gorgias/events",
  query: {},
  body: null,
  ...over,
});

describe("ticketIdFrom", () => {
  it("reads the id out of the query", () => {
    expect(ticketIdFrom(request({ query: { ticket_id: "42" } }))).toBe("42");
  });

  it("reads the id out of the body", () => {
    expect(ticketIdFrom(request({ body: { ticket_id: 42 } }))).toBe("42");
    expect(ticketIdFrom(request({ body: { ticket: { id: 42 } } }))).toBe("42");
    expect(ticketIdFrom(request({ body: { id: 42 } }))).toBe("42");
  });

  it("gives up when there is no id", () => {
    expect(ticketIdFrom(request({ body: { hello: "world" } }))).toBeNull();
  });
});

describe("the events route", () => {
  it("answers with the card the sidebar shows", async () => {
    const { app } = appWith();
    const response = await app(request({ query: { ticket_id: "48213" } }));
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as Record<string, unknown>;
    expect(data["status"]).toBe("Draft inserted · 18 words");
    expect(data["ticket_id"]).toBe("48213");
    expect(data["order"]).toBe("Order #8123 49.90 USD");
  });

  it("holds a changed reply until a reason is picked", async () => {
    const { app, overturn } = appWith();
    const response = await app(request({ query: { ticket_id: "48213" } }));
    expect(overturn.captures).toHaveLength(0);
    const data = JSON.parse(response.body) as { reasons: unknown[] };
    expect(data.reasons).toHaveLength(8);
  });

  it("captures a reply the agent sent unchanged", async () => {
    const same = ticket({
      messages: [
        { bodyText: "My order 8123 has not arrived.", fromAgent: false, createdAt: "2026-11-16T09:00:00" },
        { bodyText: DRAFT_TEXT, fromAgent: true, createdAt: "2026-11-16T10:00:00" },
      ],
    });
    const { app, overturn } = appWith({ ticket: same });
    await app(request({ query: { ticket_id: "48213" } }));
    expect(overturn.captures).toHaveLength(1);
    expect(overturn.captures[0]?.source).toBe("gorgias");
    expect(overturn.captures[0]?.externalId).toBe("gr:48213");
  });

  it("does not capture the same reply twice", async () => {
    const same = ticket({
      messages: [
        { bodyText: "My order 8123 has not arrived.", fromAgent: false, createdAt: "2026-11-16T09:00:00" },
        { bodyText: DRAFT_TEXT, fromAgent: true, createdAt: "2026-11-16T10:00:00" },
      ],
    });
    const { app, overturn } = appWith({ ticket: same });
    await app(request({ query: { ticket_id: "48213" } }));
    await app(request({ query: { ticket_id: "48213" } }));
    expect(overturn.captures).toHaveLength(1);
  });

  it("never breaks a ticket when Gorgias is down", async () => {
    const { app } = appWith({ gorgiasFail: true });
    const response = await app(request({ query: { ticket_id: "48213" } }));
    expect(response.status).toBe(200);
    const data = JSON.parse(response.body) as { error?: string };
    expect(data.error).toContain("gorgias is down");
  });

  it("refuses a request without the key", async () => {
    const { app } = appWith({ appKey: "secret" });
    const response = await app(request({ query: { ticket_id: "48213" } }));
    expect(response.status).toBe(401);
  });
});

describe("the reason route", () => {
  it("captures with the reason the agent clicked", async () => {
    const { app, overturn } = appWith();
    await app(request({ query: { ticket_id: "48213" } }));
    const response = await app(
      request({
        method: "GET",
        path: "/gorgias/reason",
        query: { ticket_id: "48213", code: "wrong_answer" },
      }),
    );
    expect(response.status).toBe(200);
    expect(overturn.captures).toHaveLength(1);
    expect(overturn.captures[0]?.reasonCode).toBe("wrong_answer");
  });

  it("shows the form when no code was clicked", async () => {
    const { app } = appWith();
    const response = await app(
      request({ method: "GET", path: "/gorgias/reason", query: { ticket_id: "48213" } }),
    );
    expect(response.contentType).toContain("text/html");
    expect(response.body).toContain("wrong_answer");
    expect(response.body).toContain('name="note"');
  });

  it("captures the note the agent typed", async () => {
    const { app, overturn } = appWith();
    await app(request({ query: { ticket_id: "48213" } }));
    const response = await app(
      request({
        method: "POST",
        path: "/gorgias/reason",
        query: { ticket_id: "48213" },
        body: { code: "against_policy", note: "we cannot promise Thursday" },
      }),
    );
    expect(response.status).toBe(200);
    expect(overturn.captures).toHaveLength(1);
    expect(overturn.captures[0]?.reasonCode).toBe("against_policy");
    expect(overturn.captures[0]?.reason).toBe("we cannot promise Thursday");
  });

  it("says so when there is nothing to capture", async () => {
    const { app, overturn } = appWith();
    const response = await app(
      request({
        method: "GET",
        path: "/gorgias/reason",
        query: { ticket_id: "48213", code: "wrong_answer" },
      }),
    );
    expect(response.body).toContain("Nothing to capture");
    expect(overturn.captures).toHaveLength(0);
  });

  it("does not break when the capture fails", async () => {
    const overturn = overturnFake({ fail: true });
    const { app } = appWith({ overturn });
    await app(request({ query: { ticket_id: "48213" } }));
    const response = await app(
      request({
        method: "GET",
        path: "/gorgias/reason",
        query: { ticket_id: "48213", code: "wrong_answer" },
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("the widget route", () => {
  it("answers with the card", async () => {
    const { app } = appWith();
    const response = await app(
      request({ method: "GET", path: "/gorgias/widget", query: { ticket_id: "48213" } }),
    );
    expect(response.contentType).toContain("application/json");
    const data = JSON.parse(response.body) as { status: string };
    expect(data.status).toContain("Draft inserted");
  });
});

describe("unknown routes", () => {
  it("answer 404", async () => {
    const { app } = appWith();
    const response = await app(request({ method: "GET", path: "/nope" }));
    expect(response.status).toBe(404);
  });
});
