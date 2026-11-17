import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, decideOnSend, originFrom, quickReasons, settingsFrom, statusLine } from "./capture.js";

const conversation = {
  id: "cnv_42", subject: "Billing", url: "https://app.intercom.com/a/inbox/inbox/all/conversation/cnv_42",
  messages: [
    { role: "customer" as const, content: "Charged twice", author: "customer@example.com", at: "2026-01-01T00:00:00Z" },
    { role: "agent" as const, content: "Looking into it", author: "agent@example.com" },
  ],
};
const draft = { text: "We can refund your duplicate charge.", origin: "ai" as const, at: 1000 };
const base = { conversation, draft, sent: { text: "We can refund your duplicate charge." }, actor: "agent@example.com", reasonCode: null, reason: "", settings: DEFAULT_SETTINGS, now: 5000 };

describe("Intercom capture", () => {
  it("defaults to support reasons and parses settings", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(settingsFrom({ reason_pack: "claims", require_reason: "false", overturn_base_url: "https://example.com/" })).toMatchObject({ reasonPack: "claims", requireReason: false, baseUrl: "https://example.com" });
    expect(settingsFrom({ reason_pack: "invalid" }).reasonPack).toBe("support");
  });
  it("captures unchanged AI draft with context and source identity", () => {
    const result = decideOnSend(base);
    expect(result.action).toBe("capture");
    if (result.action !== "capture") return;
    expect(result.body).toMatchObject({ source: "intercom", externalId: "ic:cnv_42", agent: "support-reply", actor: "agent@example.com", subject: "Billing", draft: { text: draft.text }, sent: { text: draft.text }, tags: ["draft:ai"], secondsToSend: 4 });
    expect(result.body.context).toEqual([{ role: "customer", content: "Charged twice", author: "customer@example.com", at: "2026-01-01T00:00:00Z" }, { role: "agent", content: "Looking into it", author: "agent@example.com", at: null }]);
    expect(result.body.draft.fields).toBeUndefined();
    expect(result.changed).toBe(false);
  });
  it("requires a code for changed text, but never returns a send-blocking action", () => {
    const changed = { ...base, sent: { text: "We cannot refund this charge." } };
    expect(decideOnSend(changed)).toMatchObject({ action: "skip", why: "reason-required" });
    const result = decideOnSend({ ...changed, reasonCode: "wrong_answer", reason: "Duplicate was already refunded" });
    expect(result.action).toBe("capture");
    if (result.action === "capture") expect(result.body).toMatchObject({ reasonCode: "wrong_answer", reason: "Duplicate was already refunded" });
    expect(decideOnSend({ ...changed, settings: { ...DEFAULT_SETTINGS, requireReason: false } }).action).toBe("capture");
  });
  it("scores changed decision fields and omits empty replies", () => {
    const result = decideOnSend({ ...base, draft: { ...draft, fields: { status: "pending" } }, sent: { text: draft.text, fields: { status: "refunded" } }, reasonCode: "wrong_answer" });
    expect(result.action).toBe("capture");
    if (result.action === "capture") {
      expect(result.changedFields).toEqual(["status"]);
      expect(result.body.draft.fields).toEqual({ status: "pending" });
      expect(result.body.sent.fields).toEqual({ status: "refunded" });
    }
    expect(decideOnSend({ ...base, sent: { text: "  " } })).toMatchObject({ action: "skip", why: "empty" });
  });
  it("does not infer AI from a text jump or missing origin", () => {
    expect(originFrom(undefined)).toBe("unknown");
    expect(originFrom("inserted")).toBe("unknown");
    expect(originFrom("fin_assist")).toBe("ai");
    expect(originFrom("human_typed")).toBe("manual");
    expect(decideOnSend({ ...base, draft: { ...draft, origin: "unknown" } }).action).toBe("capture");
    const result = decideOnSend({ ...base, draft: { ...draft, origin: "unknown" } });
    if (result.action === "capture") expect(result.body.tags).toEqual(["draft:unknown"]);
    expect(statusLine({ ...draft, origin: "unknown" })).toBe("Draft inserted · 6 words");
  });
});
