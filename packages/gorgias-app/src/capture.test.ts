import { describe, expect, it } from "vitest";
import {
  configError,
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  discardRun,
  draftFromHand,
  draftFromRun,
  inScope,
  isSentReply,
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

const draft = {
  text: draftText,
  origin: "recorded" as const,
  at: 0,
  fields: {},
  runId: recorded.id,
};

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
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("refuses to boot without a token to put in front of the routes", () => {
    const ready = settingsFrom({ widget_token: "s".repeat(32), app_url: "https://app.overturn.test" });
    expect(configError(ready)).toBeNull();
    expect(configError(settingsFrom({ app_url: "https://app.overturn.test" }))).toMatch(
      /WIDGET_TOKEN is required/,
    );
    expect(
      configError(settingsFrom({ widget_token: "short", app_url: "https://app.overturn.test" })),
    ).toMatch(/at least 24 characters/);
    expect(configError(settingsFrom({ widget_token: "s".repeat(32) }))).toMatch(/APP_URL is required/);
    expect(
      configError(settingsFrom({ widget_token: "s".repeat(32), app_url: "http://app.overturn.test" })),
    ).toMatch(/must be https/);
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
    const d = draftFromRun({ ...recorded, endedAt: "2026-10-01T12:00:00Z" }, { now: 1 });
    expect(d).toEqual({
      text: draftText,
      origin: "recorded",
      runId: recorded.id,
      model: null,
      at: Date.parse("2026-10-01T12:00:00Z"),
      fields: {},
    });
    expect(draftFromRun({ ...recorded, output: "  " }, { now: 1 })).toBeNull();
    expect(draftFromRun({ ...recorded, output: { text: draftText } }, { now: 1 })).toBeNull();
    expect(draftFromRun({ ...recorded, endedAt: "not a date" }, { now: 7 })?.at).toBe(7);
  });

  it("keeps the decision fields it was created with, so the diff has a baseline", () => {
    expect(draftFromRun(recorded, { fields: { status: "processing" } })?.fields).toEqual({
      status: "processing",
    });
  });

  it("never comes from a run capture synthesized, or from one already spent", () => {
    expect(discardRun({ ...recorded, source: "capture" })).toBe(true);
    expect(discardRun({ ...recorded, tags: ["capture:gorgias"] })).toBe(true);
    expect(discardRun(recorded)).toBe(false);
    // A run used for an earlier reply is history, not the draft for this one.
    expect(discardRun(recorded, [recorded.id])).toBe(true);
    expect(discardRun(recorded, ["another-run"])).toBe(false);
  });

  it("can be offered by hand when nothing recorded it, and is not a greeting", () => {
    const s = settingsFrom({ min_draft_chars: "40" });
    expect(draftFromHand(draftText, s, { now: 5 })).toEqual({
      text: draftText,
      origin: "human",
      at: 5,
      fields: {},
    });
    expect(draftFromHand(draftText, s, { origin: "assist" })?.origin).toBe("assist");
    // An unknown source stays unknown: it is not silently counted as AI.
    expect(draftFromHand(draftText, s, { origin: "unknown" })?.origin).toBe("unknown");
    expect(draftFromHand("Hi Dana!", s)).toBeNull();
  });
});

describe("a reply", () => {
  it("is only a reply once Gorgias says it was sent", () => {
    const base = { public: true, fromAgent: true, text: draftText, id: 9 };
    expect(isSentReply({ ...base, sentAt: "2026-10-01T13:00:00Z" })).toBe(true);
    // Created but not sent yet: the customer has not seen it, so it is not a reply.
    expect(isSentReply({ ...base, createdAt: "2026-10-01T13:00:00Z" })).toBe(false);
    // A failed send is not a reply either.
    expect(isSentReply({ ...base, sentAt: "2026-10-01T13:00:00Z", failedAt: "2026-10-01T13:00:05Z" })).toBe(
      false,
    );
    // A customer's message is never the agent's reply.
    expect(isSentReply({ ...base, fromAgent: false, sentAt: "2026-10-01T13:00:00Z" })).toBe(false);
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
    const decision = decideOnSend({
      ticket,
      draft: { ...draft, at: 1_000_000 },
      send: {
        text: `${draftText} Heard back from the warehouse: it ships on Monday.`,
        public: true,
        fields: {},
        messageId: 9,
      },
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
      sent: { text: `${draftText} Heard back from the warehouse: it ships on Monday.` },
      reason: "Warehouse ships Mondays, not same day",
      reasonCode: "wrong_amount_or_date",
      secondsToSend: 2.5,
      draftRunId: recorded.id,
      draftModel: null,
      url: "https://acme.gorgias.com/app/tickets/48213",
      tags: ["draft:recorded", "public-reply"],
      metadata: {
        customer: "dana@example.com",
        gorgiasMessageId: 9,
        order: { "Order id": "4509", "Order status": "processing" },
      },
    });
  });

  it("freezes the decision fields the draft was created with", () => {
    const settings = settingsFrom({ decision_fields: "status:status, 4509:order_id" });
    const decision = decideOnSend({
      ticket: { ...ticket, fields: { status: "replacement_sent", order_id: "4509" } },
      draft: {
        text: draftText,
        origin: "recorded",
        at: 0,
        fields: { status: "processing", order_id: "4509" },
      },
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
      draft: { text: draftText, origin: "human", at: 0, fields: {} },
      send: { text: `  ${draftText}\n`, public: true, fields: {}, messageId: 9 },
      reasonCode: "wrong_answer",
      reason: "picked by mistake",
      actor: null,
      settings: DEFAULT_SETTINGS,
      now: 1_000,
    });
    expect(decision).toMatchObject({ action: "capture", changed: false, changedFields: [] });
    expect(decision.action === "capture" ? decision.body.reasonCode : "x").toBeNull();
    expect(decision.action === "capture" ? decision.body.tags : []).toEqual(["draft:human", "public-reply"]);
  });

  it("holds a changed reply until a reason is picked, and keeps the body ready", () => {
    const decision = decideOnSend({
      ticket,
      draft,
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
    const decision = decideOnSend({
      ticket,
      draft,
      send: { text: "Something else entirely.", public: true, fields: {}, messageId: 9 },
      reasonCode: null,
      reason: "",
      actor: null,
      settings: settingsFrom({ require_reason: "false" }),
      now: 10,
    });
    expect(decision).toMatchObject({ action: "capture", changed: true });
  });

  it("skips internal notes unless the installer asked for them", () => {
    const input = {
      ticket,
      draft,
      send: { text: draftText, public: false, fields: {}, messageId: 9 },
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

  it("skips an empty send", () => {
    const decision = decideOnSend({
      ticket,
      draft,
      send: { text: "  \n ", public: true, fields: {}, messageId: 9 },
      reasonCode: null,
      reason: "",
      actor: null,
      settings: DEFAULT_SETTINGS,
      now: 1,
    });
    expect(decision).toEqual({ action: "skip", why: "empty" });
  });
});

describe("the status line", () => {
  it("says what is in the reply box, in words, and never invents a source", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ ...draft, text: "one two three" }, null)).toBe("Draft inserted · 3 words");
    expect(statusLine({ ...draft, text: "one two three", origin: "assist" }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine({ ...draft, text: "one two", origin: "human" }, null)).toBe(
      "Draft marked by you · 2 words",
    );
    expect(statusLine({ ...draft, text: "one two", origin: "unknown" }, null)).toBe(
      "Draft saved (source unknown) · 2 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false })).toBe("Sent as drafted · approved");
    expect(statusLine(null, { kind: "edit", changed: true })).toBe("Captured · edit saved as a case");
  });
});
