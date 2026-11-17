import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  createPendingCapture,
  DEFAULT_SETTINGS,
  decideOnSend,
  inScope,
  latestOrderFrom,
  ORDER_FIELD_KEYS,
  orderFieldsFrom,
  type SendDecision,
  sentFromMessages,
  settingsFrom,
  statusLine,
  type TicketSnapshot,
} from "./capture";

const draftText =
  "Hi Ana, your order #1042 has shipped and is out for delivery today. The tracking email from the carrier has the live link. If it has not arrived by 6 pm, reply here and I will chase it the same day.";

const ticket: TicketSnapshot = {
  id: 555,
  subject: "Where is my order?",
  customerName: "Ana",
  customerEmail: "ana@example.com",
  messages: [
    {
      id: 1,
      body: "<p>Ordered Monday, still nothing.</p>",
      kind: "customer",
      authorEmail: "ana@example.com",
      createdAt: "2026-10-03T08:00:00Z",
    },
  ],
  order: {
    id: 9001,
    number: "1042",
    total: 59.9,
    currency: "EUR",
    status: "paid",
    fulfillmentStatus: "fulfilled",
  },
  tags: [],
  fields: {},
  url: "https://acme.gorgias.com/app/ticket/555",
};

describe("settings", () => {
  it("defaults to the support pack on this surface", () => {
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(settingsFrom({}).reasonPack).toBe("support");
    expect(settingsFrom({ reason_pack: "claims" }).reasonPack).toBe("claims");
  });
  it("scope tag limits which tickets are watched", () => {
    const s = settingsFrom({ scope_tag: "ai-drafted" });
    expect(inScope(["ai-drafted"], s)).toBe(true);
    expect(inScope(["vip"], s)).toBe(false);
    expect(inScope([], DEFAULT_SETTINGS)).toBe(true);
  });
});

describe("latestOrderFrom", () => {
  // The shape Gorgias really serves: orders under customer.integrations, not on the ticket.
  const integrations = {
    "6": {
      __integration_type__: "shopify",
      orders: [
        {
          id: 501,
          name: "#1041",
          financial_status: "refunded",
          fulfillment_status: "fulfilled",
          total_price: "19.00",
          currency: "USD",
          created_at: "2026-09-01T10:00:00Z",
        },
        {
          id: 502,
          name: "#1042",
          financial_status: "paid",
          fulfillment_status: null,
          total_price: "54.90",
          currency: "USD",
          created_at: "2026-10-28T09:00:00Z",
          shipping_address: { address1: "1 Main St" },
        },
      ],
    },
    "13": { __integration_type__: "klaviyo" },
  };

  it("takes the newest order across integrations, mapped onto the ticket order shape", () => {
    expect(latestOrderFrom(integrations)).toEqual({
      id: 502,
      number: "#1042",
      total: "54.90",
      currency: "USD",
      status: "paid",
      fulfillmentStatus: undefined,
    });
  });
  it("the mapped order feeds the scored order fields, and nothing else", () => {
    const fields = orderFieldsFrom({ ...ticket, order: latestOrderFrom(integrations) });
    expect(fields).toEqual({
      order_id: 502,
      order_number: "#1042",
      order_total: "54.90",
      order_currency: "USD",
      order_status: "paid",
    });
    expect(JSON.stringify(fields)).not.toContain("Main St");
  });
  it("an order without a name falls back to its id, and no orders means no order", () => {
    expect(latestOrderFrom({ "6": { orders: [{ id: 777, total_price: "5.00" }] } })).toEqual({
      id: 777,
      number: 777,
      total: "5.00",
      currency: undefined,
      status: undefined,
      fulfillmentStatus: undefined,
    });
    expect(latestOrderFrom(null)).toBeNull();
    expect(latestOrderFrom({})).toBeNull();
    expect(latestOrderFrom({ "6": { orders: [{ total_price: "5.00" }] } })).toBeNull();
  });
});

describe("orderFieldsFrom", () => {
  it("maps the ticket's order onto the one fixed key list", () => {
    expect(orderFieldsFrom(ticket)).toEqual({
      order_id: 9001,
      order_number: "1042",
      order_total: 59.9,
      order_currency: "EUR",
      order_status: "paid",
      fulfillment_status: "fulfilled",
    });
    expect(Object.keys(orderFieldsFrom(ticket)).sort()).toEqual([...ORDER_FIELD_KEYS].sort());
  });
  it("a ticket with no order has no order fields, and partial orders keep only what exists", () => {
    expect(orderFieldsFrom({ ...ticket, order: null })).toEqual({});
    expect(orderFieldsFrom({ ...ticket, order: { number: "1043" } })).toEqual({
      order_number: "1043",
    });
  });
});

describe("decideOnSend", () => {
  const base = {
    ticket,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "mia@shop.com",
    settings: DEFAULT_SETTINGS,
    now: 1_042_000,
  };
  const draft = {
    text: draftText,
    origin: "recorded" as const,
    runId: "22222222-2222-4222-8222-222222222222",
    at: 1_000_000,
  };

  it("posts a gorgias capture the shared contract accepts, order fields on both answers", () => {
    const d = decideOnSend({ ...base, draft, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:555");
    expect(d.body.tags).toEqual(["draft:recorded", "public-reply"]);
    expect(d.body.draft.fields).toEqual(d.body.sent.fields);
    expect(d.body.draft.fields?.order_number).toBe("1042");
    expect(d.body.metadata?.order_number).toBe("1042");
    // The shared capture contract names "gorgias" as a source; without it this parse fails.
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("an order change between draft and send is a scored field change", () => {
    const d = decideOnSend({
      ...base,
      draft,
      draftFields: { order_status: "paid" },
      send: { text: draftText, type: "publicReply", fields: { order_status: "refunded" } },
      reasonCode: "wrong_answer",
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.changed).toBe(true);
    expect(d.changedFields).toContain("order_status");
  });

  it("a changed reply with no reason is held while require_reason is on", () => {
    const d = decideOnSend({
      ...base,
      draft,
      send: { text: "It shipped today, tracking in your email.", type: "publicReply", fields: {} },
    });
    expect(d).toEqual({ action: "need-reason", changedFields: [] });
  });

  it("skips: no draft, empty send, internal note by default", () => {
    expect(
      decideOnSend({ ...base, draft: null, send: { text: "x", type: "publicReply", fields: {} } }),
    ).toEqual({ action: "skip", why: "no-draft" });
    expect(
      decideOnSend({ ...base, draft, send: { text: "<p></p>", type: "publicReply", fields: {} } }),
    ).toEqual({ action: "skip", why: "empty" });
    expect(
      decideOnSend({ ...base, draft, send: { text: "note", type: "internalNote", fields: {} } }),
    ).toEqual({ action: "skip", why: "internal-note" });
  });

  it("a ticket without an order captures with no fields at all", () => {
    const d = decideOnSend({
      ...base,
      ticket: { ...ticket, order: null },
      draft,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.body.draft.fields).toBeUndefined();
    expect(d.body.metadata?.order_number).toBeUndefined();
    expect(captureCreateSchema.safeParse(d.body).success).toBe(true);
  });

  it("the sent reply is the sent answer, not part of the context the agent saw", () => {
    const sentText =
      "Hi Ana, your order #1042 has shipped and is out for delivery today. The tracking email from the carrier has the live link.";
    const withReply: typeof ticket = {
      ...ticket,
      messages: [
        ...ticket.messages,
        {
          id: 2,
          body: `<p>${sentText}</p>`,
          kind: "agent",
          authorEmail: "mia@shop.com",
          createdAt: "2026-10-03T08:05:00Z",
        },
      ],
    };
    const d = decideOnSend({
      ...base,
      ticket: withReply,
      draft,
      reasonCode: "tone_wording",
      send: { id: 2, text: sentText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error("expected capture");
    expect(d.body.sent.text).toBe(sentText);
    expect(d.body.reasonCode).toBe("tone_wording");
    expect(d.body.context).toEqual([
      {
        role: "customer",
        author: "ana@example.com",
        content: "Ordered Monday, still nothing.",
        at: "2026-10-03T08:00:00Z",
      },
    ]);
  });
});

describe("sentFromMessages", () => {
  it("returns the first agent message that was not already seen, with its id and sender", () => {
    const msgs = [
      { id: 1, body: "customer", kind: "customer" },
      { id: 2, body: "the reply", kind: "agent", authorEmail: "mia@shop.com" },
    ];
    expect(sentFromMessages(new Set([1]), msgs, DEFAULT_SETTINGS)).toEqual({
      id: 2,
      text: "the reply",
      type: "publicReply",
      fields: {},
      actor: "mia@shop.com",
    });
    expect(sentFromMessages(new Set([1, 2]), msgs, DEFAULT_SETTINGS)).toBeNull();
  });
  it("the sender falls back to the author name when no email is on the message", () => {
    const msgs = [{ id: 2, body: "the reply", kind: "agent", authorName: "Mia" }];
    expect(sentFromMessages(new Set(), msgs, DEFAULT_SETTINGS)?.actor).toBe("Mia");
  });
  it("an internal note is a send only when notes are captured", () => {
    const note = [{ id: 3, body: "internal", kind: "note" }];
    expect(sentFromMessages(new Set(), note, DEFAULT_SETTINGS)).toBeNull();
    expect(sentFromMessages(new Set(), note, { ...DEFAULT_SETTINGS, captureInternalNotes: true })).toEqual({
      id: 3,
      text: "internal",
      type: "internalNote",
      fields: {},
      actor: null,
    });
  });
});

describe("pending capture", () => {
  it("holds only need-reason decisions and resolves exactly once", () => {
    const pending = createPendingCapture();
    let calls = 0;
    const retry = (): SendDecision => {
      calls++;
      return decideOnSend({
        ticket,
        draft: { text: draftText, origin: "manual", at: 1_000_000 },
        draftFields: {},
        send: { text: draftText, type: "publicReply", fields: {} },
        reasonCode: "tone_wording",
        reason: "",
        actor: null,
        settings: DEFAULT_SETTINGS,
        now: 1_042_000,
      });
    };
    expect(pending.hold({ action: "skip", why: "empty" }, retry)).toBe(false);
    expect(pending.hold({ action: "need-reason", changedFields: [] }, retry)).toBe(true);
    expect(pending.resolve()?.action).toBe("capture");
    expect(calls).toBe(1);
    expect(pending.resolve()).toBeNull();
  });
});

describe("statusLine", () => {
  it("names where the draft came from", () => {
    expect(statusLine({ text: "one two", origin: "manual", at: 0 }, null)).toBe(
      "Draft marked by you · 2 words",
    );
    expect(statusLine({ text: "one two", origin: "recorded", at: 0 }, null)).toBe(
      "Draft recorded by your agent · 2 words",
    );
    expect(statusLine(null, null)).toBe("Waiting for a draft");
  });
});
