import { describe, expect, it } from "vitest";
import { createDraftDetector, decideOnSend, settingsFrom, quickReasons, statusLine, type TicketSnapshot } from "./capture";

const ticket: TicketSnapshot = {
  id: 42, subject: "Order #1001 return", url: "https://shop.gorgias.com/app/ticket/42",
  customerEmail: "buyer@example.com", order: { id: "1001", status: "shipped" },
  messages: [
    { body: "<p>Where is my order?</p>", fromAgent: false, author: "buyer@example.com", at: "2026-10-01T00:00:00Z" },
    { body: "<p>Check shipment</p>", fromAgent: true, internal: true, author: "Agent" },
  ],
};
const draft = { text: "<p>Your order has shipped. It arrives Friday.</p>", origin: "inserted" as const, at: 1000 };
const base = { ticket, draft, draftFields: { status: "shipped" }, actor: "agent@example.com", reasonCode: null, reason: "", settings: settingsFrom({}), now: 4000 };

describe("Gorgias capture", () => {
  it("defaults to support reasons and allows claims opt-in", () => {
    expect(quickReasons(settingsFrom({})).map((r) => r.code)).toContain("should_escalate");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain("reserve_too_low");
    expect(settingsFrom({}).requireReason).toBe(true);
    expect(settingsFrom({ require_reason: false }).requireReason).toBe(false);
  });
  it("detects a single insertion, not incremental typing, and reports words", () => {
    const detector = createDraftDetector({ minDraftChars: 18 });
    detector.onComposer("", 0);
    detector.onComposer("Hi", 100);
    expect(detector.onComposer("Hi there", 200)).toBeNull();
    const inserted = detector.onComposer("Hi there this is your order update", 300);
    expect(inserted?.origin).toBe("inserted");
    expect(statusLine(inserted, null)).toBe("Draft inserted · 7 words");
    expect(detector.onComposer("Hi there this is your order update!", 400)).toBeNull();
  });
  it("builds approve payload with ticket thread, order metadata and fields", () => {
    const d = decideOnSend({ ...base, sentText: draft.text, sentFields: { status: "shipped" } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body).toMatchObject({ source: "gorgias", externalId: "gr:42", agent: "support-reply", actor: "agent@example.com", subject: "Order #1001 return", reasonCode: null, secondsToSend: 3, metadata: { customer: "buyer@example.com", order: { id: "1001", status: "shipped" } }, draft: { text: "Your order has shipped. It arrives Friday.", fields: { status: "shipped" } }, sent: { text: "Your order has shipped. It arrives Friday.", fields: { status: "shipped" } } });
    expect(d.body.context).toEqual([
      { role: "customer", author: "buyer@example.com", content: "Where is my order?", at: "2026-10-01T00:00:00Z" },
      { role: "note", author: "Agent", content: "Check shipment", at: null },
    ]);
  });
  it("requires a selected reason for changed replies and fields but does not block sends", () => {
    const changed = { ...base, sentText: "It arrives Monday.", sentFields: { status: "delayed" } };
    expect(decideOnSend({ ...changed, reason: "Shipping delay" })).toEqual({ action: "need-reason", changedFields: ["status"] });
    const d = decideOnSend({ ...changed, reasonCode: "wrong_amount_or_date", reason: " Shipping delay " });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.reason).toBe("Shipping delay");
    expect(d.body.sent.fields).toEqual({ status: "delayed" });
  });
  it("skips empty sends, notes and tickets without a draft; omits unconfigured fields", () => {
    expect(decideOnSend({ ...base, draft: null, sentText: "hi", sentFields: {} }).action).toBe("skip");
    expect(decideOnSend({ ...base, sentText: "<p></p>", sentFields: {} }).action).toBe("skip");
    expect(decideOnSend({ ...base, sentText: "hi", sentFields: {}, internal: true }).action).toBe("skip");
    const d = decideOnSend({ ...base, sentText: draft.text, sentFields: {}, draftFields: {} });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.sent.fields).toBeUndefined();
  });
});
