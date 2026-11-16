import { describe, expect, it, vi } from "vitest";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  type FetchLike,
  type GorgiasTicketSnapshot,
  inScope,
  postCapture,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Maya,</p><p>Your order #SH-4410 shipped yesterday and is scheduled for delivery tomorrow.</p>";

const ticket: GorgiasTicketSnapshot = {
  id: 77412,
  subject: "Where is my order #SH-4410?",
  customerEmail: "maya@shopper.com",
  customerName: "Maya",
  messages: [
    {
      id: 1,
      bodyHtml: "<p>Hi, I placed order #SH-4410 three days ago.<br>Any tracking update?</p>",
      fromAgent: false,
      senderEmail: "maya@shopper.com",
      createdAt: "2026-11-16T09:00:00Z",
    },
    {
      id: 2,
      bodyHtml: "Shopify shows carrier label printed.",
      fromAgent: true,
      isInternalNote: true,
      senderName: "Alex",
    },
  ],
  fields: {},
  order: {
    orderId: "ord_991",
    orderNumber: "#SH-4410",
    orderStatus: "paid",
    fulfillmentStatus: "in_transit",
    refundAmount: 0,
    currency: "USD",
  },
  tags: ["ai_drafted", "shopify"],
  url: "https://store.gorgias.com/app/ticket/77412",
};

describe("settings & ecommerce support defaults", () => {
  it("defaults reason_pack to support and parses decision_fields", () => {
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");

    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      decision_fields: "order_action:action, refund_approved:refund",
      min_draft_chars: "100",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.decisionFields).toEqual([
      { id: "order_action", label: "action" },
      { id: "refund_approved", label: "refund" },
    ]);
    expect(s.minDraftChars).toBe(100);
  });

  it("scopes by tag when scope_tag is configured", () => {
    expect(inScope(["vip"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(inScope(["vip"], scoped)).toBe(false);
    expect(inScope(["vip", "ai_drafted"], scoped)).toBe(true);
  });
});

describe("draft detection & statusLine", () => {
  it("detects inserted draft and formats Draft inserted · N words", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    const detected = d.onComposer(
      "Hi Maya, your order #SH-4410 is currently in transit and scheduled to arrive tomorrow.",
      500,
    );
    expect(detected?.origin).toBe("inserted");
    expect(statusLine(detected, null)).toMatch(/^Draft inserted · \d+ words$/);
  });

  it("ignores gradual human typing", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    let text = "";
    for (let i = 1; i <= 60; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
  });
});

describe("context & html", () => {
  it("strips html and maps customer/note/agent roles", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(ticket)).toEqual([
      {
        role: "customer",
        author: "maya@shopper.com",
        content: "Hi, I placed order #SH-4410 three days ago.\nAny tracking update?",
        at: "2026-11-16T09:00:00Z",
      },
      {
        role: "note",
        author: "Alex",
        content: "Shopify shows carrier label printed.",
        at: null,
      },
    ]);
  });
});

describe("decideOnSend & order context", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1 };
  const base = {
    ticket,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "alex@store.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("builds source=gorgias, externalId=gr:<id>, and carries ecommerce order metadata", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:77412");
    expect(d.body.context).toHaveLength(2);
    expect(d.body.metadata).toMatchObject({
      customer: "maya@shopper.com",
      orderId: "ord_991",
      orderNumber: "#SH-4410",
      orderStatus: "paid",
      fulfillmentStatus: "in_transit",
      currency: "USD",
    });
  });

  it("honours require_reason on edited replies", () => {
    const sent = draftText.replace("tomorrow", "Friday");
    const blocked = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });

    const ok = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reasonCode: "wrong_answer",
      reason: "Carrier delayed delivery to Friday",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") {
      expect(ok.body.reasonCode).toBe("wrong_answer");
      expect(ok.body.reason).toBe("Carrier delayed delivery to Friday");
    }
  });

  it("never throws when capture fails", async () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    if (d.action !== "capture") throw new Error("expected capture");
    const log = vi.fn();
    const failHttp: FetchLike = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const res = await postCapture(failHttp, DEFAULT_SETTINGS, d.body, log);
    expect(res).toEqual({ ok: false, status: 500 });
    expect(log).toHaveBeenCalledTimes(1);
  });
});
