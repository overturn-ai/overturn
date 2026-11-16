import { describe, expect, it } from "vitest";
import {
  createDraftDetector,
  decideOnSend,
  DEFAULT_SETTINGS,
  extractOrderFields,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
  type TicketSnapshot,
} from "./capture";

const draftText =
  "Hi Alex, thanks for reaching out. Your order #12345 is covered by our 30-day return policy. I have initiated a replacement.";

const sampleTicket: TicketSnapshot = {
  id: 4242,
  subject: "Return inquiry for order #12345",
  customerEmail: "alex@example.com",
  customerName: "Alex Smith",
  customer: {
    id: 101,
    email: "alex@example.com",
    name: "Alex Smith",
  },
  messages: [
    {
      id: 1,
      channel: "email",
      from_agent: false,
      body_text: "Hi, I received the wrong item for order #12345. Can I get a return?",
      created_datetime: "2026-11-15T10:00:00Z",
      sender: { email: "alex@example.com", name: "Alex Smith" },
    },
    {
      id: 2,
      channel: "internal-note",
      from_agent: true,
      body_text: "Customer is a VIP. Expedite replacement.",
      created_datetime: "2026-11-15T10:05:00Z",
      sender: { email: "agent@store.com", name: "Agent Jane" },
    },
  ],
  order: {
    id: "ord_999",
    order_number: "12345",
    fulfillment_status: "fulfilled",
    financial_status: "paid",
    tracking_number: "TRK-987654",
    refund_amount: 45.0,
    return_status: "approved",
  },
  fields: {
    priority: "high",
  },
  url: "https://my-store.gorgias.com/app/tickets/4242",
};

const base = {
  ticket: sampleTicket,
  draft: { text: draftText, origin: "inserted" as const, at: 1_700_000_000_000 },
  reasonCode: null,
  reason: "",
  actor: "agent@store.com",
  settings: DEFAULT_SETTINGS,
  now: 1_700_000_015_000,
};

describe("Gorgias capture adapter", () => {
  it("defaults to 'support' reason pack and standard Gorgias settings", () => {
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(DEFAULT_SETTINGS.agent).toBe("support-reply");
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);

    const reasons = quickReasons(DEFAULT_SETTINGS);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.map((r) => r.code)).toContain("wrong_answer");
    expect(reasons.map((r) => r.code)).toContain("missing_information");
    expect(reasons.map((r) => r.code)).toContain("wrong_amount_or_date");

    const custom = settingsFrom({
      agent: "gorgias-tier1",
      reason_pack: "claims",
      require_reason: "false",
      order_fields: "order_id,tracking_number",
    });
    expect(custom.agent).toBe("gorgias-tier1");
    expect(custom.reasonPack).toBe("claims");
    expect(custom.requireReason).toBe(false);
    expect(custom.orderFields).toEqual(["order_id", "tracking_number"]);
  });

  it("checks scope tag accurately", () => {
    const withTag = settingsFrom({ scope_tag: "ai-handled" });
    expect(inScope(["vip", "ai-handled"], withTag)).toBe(true);
    expect(inScope(["vip", "manual"], withTag)).toBe(false);
    expect(inScope(["anything"], DEFAULT_SETTINGS)).toBe(true);
  });

  it("detects draft landing in reply box and shows Draft inserted · N words", () => {
    const detector = createDraftDetector({ minDraftChars: 80 });

    // Typing short text does not count as AI draft
    expect(detector.onComposer("Hi Alex")).toBeNull();

    // Large jump (AI generated draft or pasted reply) triggers detection
    const detected = detector.onComposer(draftText, 1000);
    expect(detected).not.toBeNull();
    expect(detected?.origin).toBe("inserted");
    expect(detected?.text).toBe(draftText);

    // Status line shows 'Draft inserted · N words'
    const words = draftText.trim().split(/\s+/).length;
    expect(statusLine(detected, null)).toBe(`Draft inserted · ${words} words`);

    // Status line for approval without changes
    expect(statusLine(detected, { kind: "approval", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );

    // Status line for edit saved
    expect(statusLine(detected, { kind: "correction", changed: true, dedup: false })).toBe(
      "Captured · edit saved as a case",
    );
  });

  it("extracts order context fields for ecommerce teams", () => {
    const orderFields = extractOrderFields(sampleTicket);
    expect(orderFields.order_id).toBe("ord_999");
    expect(orderFields.order_number).toBe("12345");
    expect(orderFields.fulfillment_status).toBe("fulfilled");
    expect(orderFields.financial_status).toBe("paid");
    expect(orderFields.tracking_number).toBe("TRK-987654");
    expect(orderFields.refund_amount).toBe(45.0);
    expect(orderFields.return_status).toBe("approved");
  });

  it("builds capture payload on send with source gorgias, externalId gr:<ticket id>, and ticket context", () => {
    const sentText = draftText; // Unchanged send
    const decision = decideOnSend({
      ...base,
      send: { text: sentText, type: "publicReply" },
    });

    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;

    expect(decision.changed).toBe(false);
    expect(decision.body.source).toBe("gorgias");
    expect(decision.body.externalId).toBe("gr:4242");
    expect(decision.body.agent).toBe("support-reply");
    expect(decision.body.subject).toBe("Return inquiry for order #12345");
    expect(decision.body.url).toBe("https://my-store.gorgias.com/app/tickets/4242");
    expect(decision.body.secondsToSend).toBe(15);

    // Ticket messages as context
    expect(decision.body.context).toHaveLength(2);
    expect(decision.body.context[0]).toEqual({
      role: "customer",
      author: "alex@example.com",
      content: "Hi, I received the wrong item for order #12345. Can I get a return?",
      at: "2026-11-15T10:00:00Z",
    });
    expect(decision.body.context[1]).toEqual({
      role: "note",
      author: "agent@store.com",
      content: "Customer is a VIP. Expedite replacement.",
      at: "2026-11-15T10:05:00Z",
    });

    // Metadata includes requester and order context
    expect(decision.body.metadata?.requester).toBe("alex@example.com");
    expect(decision.body.metadata?.order).toBeDefined();
    expect((decision.body.metadata?.order as Record<string, unknown>).order_number).toBe("12345");

    // Draft and sent text and fields
    expect(decision.body.draft.text).toBe(draftText);
    expect(decision.body.sent.text).toBe(sentText);
    expect(decision.body.draft.fields?.order_number).toBe("12345");
  });

  it("honours require_reason when the draft reply was edited", () => {
    const editedText = draftText.replace("covered by our 30-day", "not covered by our standard");

    // No reasonCode provided -> requires reason
    const blocked = decideOnSend({
      ...base,
      send: { text: editedText, type: "publicReply" },
      reasonCode: null,
      reason: "",
    });

    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });

    // With reasonCode selected -> captures payload
    const withReason = decideOnSend({
      ...base,
      send: { text: editedText, type: "publicReply" },
      reasonCode: "wrong_answer",
      reason: "Item is outside return window",
    });

    expect(withReason.action).toBe("capture");
    if (withReason.action !== "capture") return;

    expect(withReason.changed).toBe(true);
    expect(withReason.body.reasonCode).toBe("wrong_answer");
    expect(withReason.body.reason).toBe("Item is outside return window");
  });

  it("detects changes in decision/order fields in addition to text", () => {
    const withDecisionFields = settingsFrom({
      decision_fields: "priority:Priority,return_status:Return Status",
    });

    const changed = decideOnSend({
      ...base,
      settings: withDecisionFields,
      send: {
        text: draftText,
        type: "publicReply",
        fields: {
          ...sampleTicket.fields,
          priority: "urgent",
        },
      },
      reasonCode: "wrong_answer",
      reason: "Escalated priority to urgent",
    });

    expect(changed.action).toBe("capture");
    if (changed.action !== "capture") return;

    expect(changed.changed).toBe(true);
    expect(changed.changedFields).toContain("priority");
  });

  it("skips capture on empty send, missing draft, or internal note if not configured", () => {
    expect(
      decideOnSend({
        ...base,
        send: { text: "", type: "publicReply" },
      }),
    ).toEqual({ action: "skip", why: "empty" });

    expect(
      decideOnSend({
        ...base,
        draft: null,
        send: { text: "Hello", type: "publicReply" },
      }),
    ).toEqual({ action: "skip", why: "no-draft" });

    expect(
      decideOnSend({
        ...base,
        send: { text: "Internal note", type: "internalNote" },
      }),
    ).toEqual({ action: "skip", why: "internal-note" });

    // But captures internal notes if captureInternalNotes is true
    const allowNotes = settingsFrom({ capture_internal_notes: true });
    const noteDecision = decideOnSend({
      ...base,
      settings: allowNotes,
      send: { text: draftText, type: "internalNote" },
    });
    expect(noteDecision.action).toBe("capture");
  });

  it("strips HTML cleanly from messages and rich text", () => {
    const html = "<p>Hello <b>Alex</b>,<br/>Your refund of &euro;50 is processed.</p>";
    const stripped = stripHtml(html);
    expect(stripped).toContain("Hello Alex");
    expect(stripped).toContain("Your refund of");
    expect(stripped).not.toContain("<p>");
    expect(stripped).not.toContain("<b>");
  });
});
