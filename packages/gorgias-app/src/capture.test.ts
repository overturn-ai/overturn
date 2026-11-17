import { describe, expect, it } from "vitest";
import {
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  fieldsFrom,
  ordersFrom,
  quickReasons,
  reasonFromTags,
  settingsFrom,
  statusLine,
  type TicketSnapshot,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Order #1042 shipped yesterday with UPS and should arrive within 3 business days. Here is your tracking link.</p>";

const integrations = {
  "12": {
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
        shipping_address: { address1: "1 Main St" },
      },
      {
        id: 502,
        name: "#1042",
        financial_status: "paid",
        fulfillment_status: null,
        total_price: "54.90",
        currency: "USD",
        created_at: "2026-10-28T09:00:00Z",
      },
    ],
  },
  "13": { __integration_type__: "klaviyo" },
};

const ticket: TicketSnapshot = {
  id: 9001,
  subject: "Where is my order?",
  customerEmail: "dana@example.com",
  customerName: "Dana",
  messages: [
    {
      id: 1,
      channel: "email",
      from_agent: false,
      public: true,
      body_text: "Ordered last week, nothing yet.",
      sender: { email: "dana@example.com" },
      created_datetime: "2026-11-01T10:00:00Z",
    },
    {
      id: 2,
      channel: "internal-note",
      from_agent: true,
      public: false,
      body_html: "<p>Label created, not scanned.</p>",
      sender: { name: "Ray" },
    },
  ],
  orders: ordersFrom(integrations, 3),
  fields: {},
  url: "https://shop.gorgias.com/app/ticket/9001",
};

const settings = { ...DEFAULT_SETTINGS, requireReason: false };
const draft = { text: draftText, origin: "inserted" as const, at: 1 };
const base = {
  ticket,
  draft,
  draftFields: {},
  reasonCode: null as string | null,
  reason: "",
  actor: "ray@shop.com",
  settings,
};

describe("settings", () => {
  it("support pack and require_reason by default", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(settingsFrom({ reason_pack: "claims", max_orders: "5" })).toMatchObject({
      reasonPack: "claims",
      maxOrders: 5,
    });
  });
});

describe("order context", () => {
  it("keeps the decision-relevant order fields, newest first, and nothing else", () => {
    expect(ticket.orders).toEqual([
      {
        id: "502",
        name: "#1042",
        financialStatus: "paid",
        fulfillmentStatus: null,
        total: "54.90",
        currency: "USD",
        createdAt: "2026-10-28T09:00:00Z",
      },
      {
        id: "501",
        name: "#1041",
        financialStatus: "refunded",
        fulfillmentStatus: "fulfilled",
        total: "19.00",
        currency: "USD",
        createdAt: "2026-09-01T10:00:00Z",
      },
    ]);
    expect(JSON.stringify(ticket.orders)).not.toContain("Main St");
    expect(ordersFrom(integrations, 1)).toHaveLength(1);
    expect(ordersFrom(null, 3)).toEqual([]);
  });
  it("puts the orders first in the context, then the thread", () => {
    const c = contextFrom(ticket);
    expect(c[0]).toEqual({
      role: "system",
      author: null,
      content:
        "Customer orders:\n#1042, 54.90 USD, paid, unfulfilled, placed 2026-10-28\n#1041, 19.00 USD, refunded, fulfilled, placed 2026-09-01",
      at: null,
    });
    expect(c.slice(1)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Ordered last week, nothing yet.",
        at: "2026-11-01T10:00:00Z",
      },
      { role: "note", author: "Ray", content: "Label created, not scanned.", at: null },
    ]);
  });
});

describe("decideOnSend", () => {
  it("skips without a draft, on notes, and on empty sends", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "x", type: "reply", fields: {} } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, send: { text: "x", type: "note", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", type: "reply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("an unchanged send is an approve with source gorgias, gr: externalId and the orders", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "reply", fields: {} } });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:9001");
    expect(d.body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(d.body.metadata?.customer).toBe("dana@example.com");
    expect(d.body.metadata?.orders).toHaveLength(2);
  });

  it("a changed reply carries the reason; require_reason holds it without a code", () => {
    const sent = draftText.replace("shipped yesterday with UPS", "has not shipped yet; it leaves Friday");
    const ok = decideOnSend({
      ...base,
      reasonCode: "wrong_answer",
      reason: "Label only, not scanned",
      send: { text: sent, type: "reply", fields: {} },
    });
    if (ok.action !== "capture") throw new Error(ok.action);
    expect(ok.body.reasonCode).toBe("wrong_answer");
    expect(ok.body.reason).toBe("Label only, not scanned");
    const strict = { ...base, settings: DEFAULT_SETTINGS };
    expect(decideOnSend({ ...strict, send: { text: sent, type: "reply", fields: {} } })).toEqual({
      action: "need-reason",
      changedFields: [],
    });
    expect(
      decideOnSend({ ...strict, reason: "note only", send: { text: sent, type: "reply", fields: {} } })
        .action,
    ).toBe("need-reason");
  });

  it("decision fields come from Gorgias custom_fields and are compared exactly", () => {
    const s = { ...settings, decisionFields: [{ id: "77", label: "resolution" }] };
    expect(fieldsFrom({ "77": { id: 77, value: "refund" } }, s)).toEqual({ resolution: "refund" });
    const d = decideOnSend({
      ...base,
      settings: s,
      draftFields: { resolution: "reship" },
      reasonCode: "against_policy",
      send: { text: draftText, type: "reply", fields: { resolution: "refund" } },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changedFields).toEqual(["resolution"]);
  });

  it("a recorded draft attaches to its run", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 10_000,
      },
      now: 14_250,
      send: { text: draftText, type: "reply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.tags).toContain("draft:recorded");
    expect(d.body.secondsToSend).toBe(4.3);
  });
});

describe("reasons from tags and status", () => {
  it("reads overturn:<code> tags for codes in the installed pack only", () => {
    expect(reasonFromTags([{ name: "vip" }, { name: "overturn:wrong_answer" }], DEFAULT_SETTINGS)).toBe(
      "wrong_answer",
    );
    expect(reasonFromTags(["Overturn:Should_Escalate"], DEFAULT_SETTINGS)).toBe("should_escalate");
    expect(reasonFromTags(["overturn:reserve_too_low"], DEFAULT_SETTINGS)).toBeNull();
    expect(reasonFromTags([], DEFAULT_SETTINGS)).toBeNull();
  });
  it("shows Draft inserted · N words", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "<p>one two three</p>", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
  });
});
