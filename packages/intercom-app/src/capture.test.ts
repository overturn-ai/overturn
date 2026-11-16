import { describe, expect, it } from "vitest";
import {
  buildCanvas,
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  inScope,
  originTag,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftHtml =
  "<p>Hi Maya,</p><p>Thanks for reaching out. Your subscription renewal has been refunded and will appear on your statement within 3 to 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "conv_918273",
  title: "Duplicate charge on renewal",
  contactEmail: "maya@example.com",
  contactName: "Maya",
  parts: [
    {
      id: "part_1",
      body: "<div>I was charged twice for my monthly plan.<br>Please help.</div>",
      partType: "comment",
      authorType: "user",
      authorEmail: "maya@example.com",
      createdAt: "2026-11-15T10:00:00Z",
    },
    {
      id: "part_2",
      body: "Stripe shows duplicate invoice in_123.",
      partType: "note",
      authorType: "admin",
      authorName: "Sam",
      createdAt: "2026-11-15T10:02:00Z",
    },
  ],
  tags: ["billing", "ai_assisted"],
  customAttributes: {},
  url: "https://app.intercom.com/a/inbox/workspace/inbox/conversation/conv_918273",
};

describe("settings", () => {
  it("parses settings and defaults reason_pack to support with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);

    const parsed = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "billing-support",
      require_reason: "false",
      capture_internal_notes: "true",
      decision_fields: "refund_status:refund_status, tier:plan_tier",
      min_draft_chars: "100",
      scope_tag: "fin_assist",
      reason_pack: "claims",
    });
    expect(parsed.baseUrl).toBe("https://ov.internal");
    expect(parsed.agent).toBe("billing-support");
    expect(parsed.requireReason).toBe(false);
    expect(parsed.captureInternalNotes).toBe(true);
    expect(parsed.decisionFields).toEqual([
      { id: "refund_status", label: "refund_status" },
      { id: "tier", label: "plan_tier" },
    ]);
    expect(parsed.minDraftChars).toBe(100);
    expect(parsed.scopeTag).toBe("fin_assist");
    expect(parsed.reasonPack).toBe("claims");
  });

  it("checks scope tags", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_assisted" });
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_assisted"], scoped)).toBe(true);
  });

  it("loads support reason codes by default", () => {
    const codes = quickReasons(DEFAULT_SETTINGS).map((r) => r.code);
    expect(codes).toContain("wrong_answer");
    expect(codes).toContain("tone_wording");
    expect(codes).not.toContain("reserve_too_low");
  });
});

describe("draft detection and origin tagging", () => {
  it("detects a draft landing in the composer and formats status line with word count", () => {
    const detector = createDraftDetector({ minDraftChars: 80 });
    expect(detector.onComposer("Hi Maya,", 1000)).toBeNull();
    const detected = detector.onComposer(draftHtml, 1500, "ai");
    expect(detected).not.toBeNull();
    expect(detected?.origin).toBe("ai");
    expect(statusLine(detected, null)).toMatch(/^Draft inserted · \d+ words$/);
  });

  it("tags draft:ai only for AI/Fin assists, draft:manual for human, and draft:unknown when untold", () => {
    expect(originTag("ai")).toBe("draft:ai");
    expect(originTag("recorded")).toBe("draft:ai");
    expect(originTag("manual")).toBe("draft:manual");
    expect(originTag("unknown")).toBe("draft:unknown");

    const detector = createDraftDetector({ minDraftChars: 80 });
    const preloadedWithoutOrigin = detector.onComposer(draftHtml, 1000);
    expect(preloadedWithoutOrigin?.origin).toBe("unknown");
  });
});

describe("context and HTML stripping", () => {
  it("strips HTML and maps Intercom conversation parts into CaptureMessage context", () => {
    expect(stripHtml("<p>Hello&nbsp;<strong>world</strong> &amp; team</p>")).toBe("Hello world & team");
    const ctx = contextFrom(conversation);
    expect(ctx).toEqual([
      {
        role: "customer",
        author: "maya@example.com",
        content: "I was charged twice for my monthly plan.\nPlease help.",
        at: "2026-11-15T10:00:00Z",
      },
      {
        role: "note",
        author: "Sam",
        content: "Stripe shows duplicate invoice in_123.",
        at: "2026-11-15T10:02:00Z",
      },
    ]);
  });
});

describe("decideOnSend", () => {
  it("builds a POST /v1/capture payload with source intercom and ic:<id> externalId", () => {
    const decision = decideOnSend({
      conversation,
      draft: { text: draftHtml, origin: "ai", at: 1000 },
      draftFields: {},
      send: {
        text: "<p>Hi Maya,</p><p>Your duplicate charge has been refunded and will settle in 2 business days.</p>",
        type: "comment",
        fields: {},
      },
      reasonCode: "wrong_amount_or_date",
      reason: "Settlement takes 2 business days, not 3-5",
      actor: "alex@company.com",
      settings: DEFAULT_SETTINGS,
      now: 6500,
    });

    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changed).toBe(true);
    expect(decision.body.source).toBe("intercom");
    expect(decision.body.externalId).toBe("ic:conv_918273");
    expect(decision.body.reasonCode).toBe("wrong_amount_or_date");
    expect(decision.body.reason).toBe("Settlement takes 2 business days, not 3-5");
    expect(decision.body.secondsToSend).toBe(5.5);
    expect(decision.body.tags).toContain("draft:ai");
    expect(decision.body.tags).toContain("public-reply");
    expect(decision.body.context).toHaveLength(2);
  });

  it("enforces require_reason on edited drafts", () => {
    const decision = decideOnSend({
      conversation,
      draft: { text: draftHtml, origin: "ai", at: 1000 },
      draftFields: {},
      send: {
        text: "<p>Hi Maya, refunded today.</p>",
        type: "comment",
        fields: {},
      },
      reasonCode: null,
      reason: "",
      actor: "alex@company.com",
      settings: DEFAULT_SETTINGS,
      now: 2000,
    });

    expect(decision.action).toBe("need-reason");
  });

  it("includes decision fields when configured and tags manual/unknown origins accurately", () => {
    const settings = settingsFrom({ decision_fields: "refund_status:refund_status" });
    const decision = decideOnSend({
      conversation,
      draft: { text: draftHtml, origin: "unknown", at: 1000 },
      draftFields: { refund_status: "pending" },
      send: {
        text: draftHtml,
        type: "comment",
        fields: { refund_status: "approved" },
      },
      reasonCode: "wrong_answer",
      reason: "",
      actor: "alex@company.com",
      settings,
      now: 2000,
    });

    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changed).toBe(true);
    expect(decision.changedFields).toEqual(["refund_status"]);
    expect(decision.body.draft.fields).toEqual({ refund_status: "pending" });
    expect(decision.body.sent.fields).toEqual({ refund_status: "approved" });
    expect(decision.body.tags).toContain("draft:unknown");
  });

  it("skips internal notes unless captureInternalNotes is enabled", () => {
    const skipped = decideOnSend({
      conversation,
      draft: { text: draftHtml, origin: "manual", at: 1000 },
      draftFields: {},
      send: { text: "Internal note", type: "note", fields: {} },
      reasonCode: null,
      reason: "",
      actor: "alex@company.com",
      settings: DEFAULT_SETTINGS,
    });
    expect(skipped).toEqual({ action: "skip", why: "internal-note" });
  });
});

describe("Canvas Kit UI", () => {
  it("renders Canvas Kit inbox components with draft status, reason picker, and optional note", () => {
    const canvas = buildCanvas({
      draft: { text: draftHtml, origin: "ai", at: 1000 },
      settings: DEFAULT_SETTINGS,
      lastResult: null,
      errorMessage: null,
    });

    const components = canvas.canvas.content.components;
    expect(components.some((c) => c.type === "text" && c.text.includes("Draft inserted · "))).toBe(true);
    expect(components.some((c) => c.type === "single-select" && c.id === "reason_code")).toBe(true);
    expect(components.some((c) => c.type === "input" && c.id === "reason_note")).toBe(true);
  });
}
