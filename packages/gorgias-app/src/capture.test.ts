import { describe, expect, it } from "vitest";
import {
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  draftFromHand,
  draftFromRun,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
  type TicketSnapshot,
} from "./capture";

const draftText =
  "Hi Dana, thanks for the photos. Your replacement lid ships today, free of charge, and I have refunded the shipping.";

const ticket: TicketSnapshot = {
  id: 48213,
  subject: "Cracked lid in order 4509",
  customerEmail: "dana@example.com",
  customerName: "Dana",
  messages: [
    {
      id: 1,
      public: true,
      fromAgent: false,
      senderEmail: "dana@example.com",
      createdAt: "2026-10-01T10:00:00Z",
      text: "The lid arrived cracked.",
    },
    {
      id: 2,
      public: false,
      fromAgent: true,
      senderName: "Ray",
      createdAt: "2026-10-01T10:05:00Z",
      text: "Order 4509, second damaged lid this month.",
    },
  ],
  fields: { status: "processing" },
  order: { "Order id": "4509", "Order status": "processing" },
  tags: ["vip"],
  url: "https://acme.gorgias.com/app/tickets/48213",
};

const recorded = { id: "0f6f0f1e-0000-4000-8000-000000000001", agent: "support-reply", output: draftText };

describe("settings", () => {
  it("parses the app's settings, the same keys the Zendesk app uses", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      app_url: "https://app.overturn.run/",
      widget_token: "w_secret",
      agent: "support-reply",
      require_reason: "false",
      capture_internal_notes: "true",
      decision_fields: "status:status, 4509:order_id",
      order_fields: "4509:order_id,4510:shipping",
      min_draft_chars: "120",
      reason_pack: "claims",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.appUrl).toBe("https://app.overturn.run");
    expect(s.widgetToken).toBe("w_secret");
    expect(s.requireReason).toBe(false);
    expect(s.captureInternalNotes).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "status", label: "status" },
      { id: "4509", label: "order_id" },
    ]);
    expect(s.orderFields).toEqual([
      { id: "4509", label: "order_id" },
      { id: "4510", label: "shipping" },
    ]);
    expect(s.minDraftChars).toBe(120);
    expect(s.reasonPack).toBe("claims");
  });

  it("defaults to the support pack, require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    expect(DEFAULT_SETTINGS.appUrl).toBe("");
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("a scope tag limits which tickets are read at all", () => {
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(inScope(["vip"], scoped)).toBe(false);
    expect(inScope(["vip", "ai_drafted"], scoped)).toBe(true);
    expect(inScope(["vip"], DEFAULT_SETTINGS)).toBe(true);
  });

  it("shows the support codes an ecommerce team wants, not the claims pack", () => {
    const codes = quickReasons(DEFAULT_SETTINGS).map((r) => r.code);
    expect(codes).toContain("wrong_answer");
    expect(codes).toContain("missing_information");
    expect(codes).toContain("should_escalate");
    expect(codes).not.toContain("reserve_too_low");
  });
});

describe("the draft", () => {
  it("is the drafting agent's recorded run, at the time that run ended", () => {
    const draft = draftFromRun({ ...recorded, endedAt: "2026-10-01T12:00:00Z" }, 1);
    expect(draft).toEqual({
      text: draftText,
      origin: "recorded",
      runId: recorded.id,
      model: null,
      at: Date.parse("2026-10-01T12:00:00Z"),
    });
    expect(draftFromRun({ ...recorded, output: "  " }, 1)).toBeNull();
    expect(draftFromRun({ ...recorded, output: { text: draftText } }, 1)).toBeNull();
    expect(draftFromRun({ ...recorded, endedAt: "not a date" }, 7)?.at).toBe(7);
  });

  it("can be offered by hand when nothing recorded it, and is not a greeting", () => {
    const s = settingsFrom({ min_draft_chars: "40" });
    expect(draftFromHand(draftText, s, { now: 5 })).toEqual({ text: draftText, origin: "manual", at: 5 });
    expect(draftFromHand(draftText, s, { origin: "inserted" })?.origin).toBe("inserted");
    expect(draftFromHand("Hi Dana!", s)).toBeNull();
  });
});

describe("context", () => {
  it("maps Gorgias messages: public replies are the thread, internal notes are notes", () => {
    expect(contextFrom(ticket)).toEqual([
      {
        role: "system",
        author: null,
        content: 'Order: {"Order id":"4509","Order status":"processing"}',
        at: null,
      },
      {
        role: "customer",
        author: "dana@example.com",
        content: "The lid arrived cracked.",
        at: "2026-10-01T10:00:00Z",
      },
      {
        role: "note",
        author: "Ray",
        content: "Order 4509, second damaged lid this month.",
        at: "2026-10-01T10:05:00Z",
      },
    ]);
  });

  it("leaves the order line out when the ticket has no order fields", () => {
    expect(contextFrom({ ...ticket, order: {} })).toHaveLength(2);
  });

  it("reads html when Gorgias gives no text", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(stripHtml("Thanks &amp; goodbye &quot;Dana&quot;")).toBe('Thanks & goodbye "Dana"');
  });
});

describe("the capture payload", () => {
  it("is what POST /v1/capture expects, keyed to the Gorgias ticket", () => {
    const draft = { ...draftFromRun({ ...recorded, endedAt: "2026-10-01T12:00:00Z" })!, at: 1_000_000 };
    const sent = `${draftText} Heard back from the warehouse: it ships on Monday.`;
    const decision = decideOnSend({
      ticket,
      draft,
      draftFields: {},
      send: { text: sent, public: true, fields: {}, messageId: 9 },
      reasonCode: "wrong_amount_or_date",
      reason: "Warehouse ships Mondays, not same day",
      actor: "ray@acme.com",
      settings: DEFAULT_SETTINGS,
      now: 1_002_500,
    });
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changed).toBe(true);
    expect(decision.body).toEqual({
      source: "gorgias",
      externalId: "gr:48213",
      agent: "support-reply",
      actor: "ray@acme.com",
      subject: "Cracked lid in order 4509",
      context: contextFrom(ticket),
      draft: { text: draftText },
      sent: { text: sent },
      reason: "Warehouse ships Mondays, not same day",
      reasonCode: "wrong_amount_or_date",
      secondsToSend: 2.5,
      draftRunId: recorded.id,
      draftModel: null,
      url: "https://acme.gorgias.com/app/tickets/48213",
      tags: ["draft:recorded", "public-reply"],
      metadata: { customer: "dana@example.com", order: { "Order id": "4509", "Order status": "processing" } },
    });
  });

  it("freezes decision fields beside the text, exactly like Zendesk", () => {
    const settings = settingsFrom({ decision_fields: "status:status, 4509:order_id" });
    const decision = decideOnSend({
      ticket: { ...ticket, fields: { status: "replacement_sent", order_id: "4509" } },
      draft: { text: draftText, origin: "recorded", at: 0 },
      draftFields: { status: "processing", order_id: "4509" },
      send: {
        text: draftText,
        public: true,
        fields: { status: "replacement_sent", order_id: "4509" },
        messageId: 9,
      },
      reasonCode: null,
      reason: "",
      actor: null,
      settings,
      now: 1,
    });
    // A changed decision field is a changed reply: the fields are the decision, the prose is not.
    expect(decision).toMatchObject({ action: "need-reason", changedFields: ["status"] });
    expect(decision.action === "need-reason" ? decision.body.draft.fields : null).toEqual({
      status: "processing",
      order_id: "4509",
    });
    expect(decision.action === "need-reason" ? decision.body.sent.fields : null).toEqual({
      status: "replacement_sent",
      order_id: "4509",
    });
  });

  it("is an approve when the reply goes out as drafted: no reason code, whatever was picked", () => {
    const decision = decideOnSend({
      ticket,
      draft: { text: draftText, origin: "manual", at: 0 },
      draftFields: {},
      send: { text: `  ${draftText}\n`, public: true, fields: {}, messageId: 9 },
      reasonCode: "wrong_answer",
      reason: "picked by mistake",
      actor: null,
      settings: DEFAULT_SETTINGS,
      now: 1_000,
    });
    expect(decision).toMatchObject({ action: "capture", changed: false, changedFields: [] });
    expect(decision.action === "capture" ? decision.body.reasonCode : "x").toBeNull();
    expect(decision.action === "capture" ? decision.body.tags : []).toEqual(["draft:manual", "public-reply"]);
  });

  it("holds a changed reply until a reason is picked, and keeps the body ready", () => {
    const decision = decideOnSend({
      ticket,
      draft: { text: draftText, origin: "recorded", at: 0 },
      draftFields: {},
      send: { text: `${draftText} Ask again if not.`, public: true, fields: {}, messageId: 9 },
      reasonCode: null,
      reason: "",
      actor: "ray@acme.com",
      settings: DEFAULT_SETTINGS,
      now: 10,
    });
    expect(decision).toMatchObject({ action: "need-reason", changedFields: [] });
    expect(decision.action === "need-reason" ? decision.body.reason : "x").toBeNull();
    expect(decision.action === "need-reason" ? decision.body.reasonCode : "x").toBeNull();
    expect(decision.action === "need-reason" ? decision.body.externalId : "").toBe("gr:48213");
  });

  it("files a changed reply without a reason when require_reason is off", () => {
    const settings = settingsFrom({ require_reason: "false" });
    const decision = decideOnSend({
      ticket,
      draft: { text: draftText, origin: "recorded", at: 0 },
      draftFields: {},
      send: { text: "Something else entirely.", public: true, fields: {}, messageId: 9 },
      reasonCode: null,
      reason: "",
      actor: null,
      settings,
      now: 10,
    });
    expect(decision).toMatchObject({ action: "capture", changed: true });
  });

  it("skips internal notes unless the installer asked for them", () => {
    const send = { text: draftText, public: false, fields: {}, messageId: 9 };
    const input = {
      ticket,
      draft: { text: draftText, origin: "recorded" as const, at: 0 },
      draftFields: {},
      send,
      reasonCode: null,
      reason: "",
      actor: null,
      settings: DEFAULT_SETTINGS,
      now: 1,
    };
    expect(decideOnSend(input)).toEqual({ action: "skip", why: "internal-note" });
    const asked = settingsFrom({ capture_internal_notes: "true" });
    const decision = decideOnSend({ ...input, settings: asked });
    expect(decision.action === "capture" ? decision.body.tags : []).toEqual([
      "draft:recorded",
      "internal-note",
    ]);
  });

  it("skips an empty send and a ticket with no draft", () => {
    const base = {
      ticket,
      draft: { text: draftText, origin: "recorded" as const, at: 0 },
      draftFields: {},
      reasonCode: null,
      reason: "",
      actor: null,
      settings: DEFAULT_SETTINGS,
      now: 1,
    };
    expect(
      decideOnSend({ ...base, send: { text: "  \n ", public: true, fields: {}, messageId: 9 } }),
    ).toEqual({
      action: "skip",
      why: "empty",
    });
    expect(
      decideOnSend({
        ...base,
        draft: null,
        send: { text: draftText, public: true, fields: {}, messageId: 9 },
      }),
    ).toEqual({ action: "skip", why: "no-draft" });
  });
});

describe("the status line", () => {
  it("says what is in the reply box, in words", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "recorded", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine({ text: "one two three", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine({ text: "one two", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 2 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false })).toBe("Sent as drafted · approved");
    expect(statusLine(null, { kind: "edit", changed: true })).toBe("Captured · edit saved as a case");
  });
});
