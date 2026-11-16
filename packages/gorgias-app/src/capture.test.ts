import { describe, expect, it } from "vitest";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  extractDecisionFields,
  type GorgiasTicketSnapshot,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for reaching out about order #10842. Your return has been authorized and your refund of $48.50 will be processed once received.</p>";

const ticket: GorgiasTicketSnapshot = {
  id: 98124,
  subject: "Return request for order #10842",
  customer: {
    id: 1234,
    email: "dana@example.com",
    name: "Dana Smith",
  },
  messages: [
    {
      id: 101,
      body_text: "Hi, I need to return the shoes from order #10842. They are unworn.",
      channel: "email",
      from_agent: false,
      sender: { email: "dana@example.com", name: "Dana Smith" },
      sent_datetime: "2026-11-01T10:00:00Z",
    },
    {
      id: 102,
      body_html: "<div>Order confirmed delivered 2 days ago. Return policy permits 30 days.</div>",
      channel: "internal-note",
      from_agent: true,
      sender: { name: "Ray Support" },
      created_datetime: "2026-11-01T10:05:00Z",
    },
  ],
  fields: {
    order_id: "10842",
    order_status: "delivered",
  },
  order: {
    id: "10842",
    total: 48.5,
    status: "delivered",
    return_eligible: true,
  },
  url: "https://shop.gorgias.com/app/tickets/98124",
};

describe("settings", () => {
  it("parses the manifest parameters and defaults to support pack", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "support-reply",
      require_reason: "true",
      decision_fields: "order_status:status, refund_amount:refund, return_status",
      min_draft_chars: "100",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("support-reply");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "order_status", label: "status" },
      { id: "refund_amount", label: "refund" },
      { id: "return_status", label: "return_status" },
    ]);
    expect(s.minDraftChars).toBe(100);
    expect(s.reasonPack).toBe("support");
  });

  it("handles camelCase setting names as well", () => {
    const s = settingsFrom({
      baseUrl: "https://api.custom.com/",
      decisionFields: "order.status:order_status",
      requireReason: false,
      minDraftChars: 60,
      scopeTag: "gorgias_ai",
      reasonPack: "claims",
    });
    expect(s.baseUrl).toBe("https://api.custom.com");
    expect(s.requireReason).toBe(false);
    expect(s.decisionFields).toEqual([{ id: "order.status", label: "order_status" }]);
    expect(s.minDraftChars).toBe(60);
    expect(s.scopeTag).toBe("gorgias_ai");
    expect(s.reasonPack).toBe("claims");
  });

  it("a scope tag limits which tickets are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(scoped.scopeTag).toBe("ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack defaults to support, with claims available when configured", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("should_escalate");
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).not.toContain("reserve_too_low");

    const claims = settingsFrom({ reason_pack: "claims" });
    expect(quickReasons(claims).map((r) => r.code)).toContain("wrong_coverage_decision");

    // Falls back to support on invalid pack
    expect(settingsFrom({ reason_pack: "unknown" }).reasonPack).toBe("support");
  });

  it("falls back to defaults, with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
  });
});

describe("draft detection", () => {
  const long = "This is a detailed response generated to assist the customer with their order return request.".repeat(
    2,
  );

  it("a reply-sized insert into an empty composer is the draft; gradual typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 50; i++) {
      text += "word ";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();

    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} plus additional user edits`, 600)).toBeNull();
  });

  it("a composer that already holds a reply on load is a preloaded draft", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });

  it("a paste after a pause while a short greeting was typed still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("inserted");
  });
});

describe("context and html", () => {
  it("strips html properly", () => {
    expect(stripHtml("<p>Order #10842&nbsp;status</p><p>Ready for<br>pickup</p>")).toBe(
      "Order #10842 status\nReady for\npickup",
    );
  });

  it("extracts context from native Gorgias messages mapping roles and authors", () => {
    const ctx = contextFrom(ticket);
    expect(ctx).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Hi, I need to return the shoes from order #10842. They are unworn.",
        at: "2026-11-01T10:00:00Z",
      },
      {
        role: "note",
        author: "Ray Support",
        content: "Order confirmed delivered 2 days ago. Return policy permits 30 days.",
        at: "2026-11-01T10:05:00Z",
      },
    ]);
  });

  it("supports comments alias and agent role mapping", () => {
    const t: GorgiasTicketSnapshot = {
      id: 555,
      subject: "Support inquiry",
      comments: [
        {
          id: 1,
          value: "Need help tracking my package",
          isAgent: false,
          authorEmail: "customer@example.com",
        },
        {
          id: 2,
          value: "<div>Tracking number is 1Z9999999999999999</div>",
          isAgent: true,
          authorName: "Support Rep",
        },
      ],
      url: null,
    };
    expect(contextFrom(t)).toEqual([
      {
        role: "customer",
        author: "customer@example.com",
        content: "Need help tracking my package",
        at: null,
      },
      {
        role: "agent",
        author: "Support Rep",
        content: "Tracking number is 1Z9999999999999999",
        at: null,
      },
    ]);
  });
});

describe("extractDecisionFields", () => {
  it("extracts decision fields from fields, custom_fields and order context", () => {
    const fields = extractDecisionFields(
      {
        fields: { order_status: "refunded" },
        custom_fields: { return_label_created: true },
        order: { id: "10842", status: "shipped", refund_amount: 48.5 },
      },
      [
        { id: "order_status", label: "status" },
        { id: "return_label_created", label: "return_label" },
        { id: "order.refund_amount", label: "refund_amount" },
        { id: "missing_field", label: "missing" },
      ],
    );
    expect(fields).toEqual({
      status: "refunded",
      return_label: true,
      refund_amount: 48.5,
      missing: null,
    });
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1000 };
  const base = {
    ticket,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "agent@store.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft, on internal notes, and on empty sends", () => {
    expect(
      decideOnSend({ ...base, draft: null, send: { text: "hello", type: "publicReply", fields: {} } }),
    ).toEqual({ action: "skip", why: "no-draft" });

    expect(decideOnSend({ ...base, send: { text: "hello", type: "internal-note", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });

    expect(decideOnSend({ ...base, send: { text: "   ", type: "publicReply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("captures internal notes when capture_internal_notes setting is on", () => {
    const s = { ...base.settings, captureInternalNotes: true };
    const res = decideOnSend({
      ...base,
      settings: s,
      send: { text: draftText, type: "internal-note", fields: {} },
    });
    expect(res.action).toBe("capture");
    if (res.action === "capture") {
      expect(res.body.tags).toContain("internal-note");
    }
  });

  it("sending the draft unchanged is an approve capture with source gorgias and externalId gr:<id>", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:98124");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(d.body.context).toHaveLength(2);
    expect(d.body.metadata).toMatchObject({
      customer: "dana@example.com",
      order: { id: "10842" },
    });
  });

  it("a changed reply is an edit capture carrying the reason and support reason code", () => {
    const sent = draftText.replace("$48.50", "$52.00");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Added $3.50 shipping fee refund",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:98124");
    expect(d.body.reason).toBe("Added $3.50 shipping fee refund");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("$52.00");
    expect(d.body.draft.text).toContain("$48.50");
  });

  it("require_reason (default true) blocks a changed send until a reason code is picked", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("authorized", "denied due to final sale");

    // Blocked with no reason code
    const blocked = decideOnSend({
      ...base,
      settings,
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });

    // Note alone is not enough
    const noteOnly = decideOnSend({
      ...base,
      settings,
      reason: "Item was marked final sale",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");

    // Allowed with reason code
    const ok = decideOnSend({
      ...base,
      settings,
      reasonCode: "against_policy",
      reason: "Final sale item cannot be returned",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") {
      expect(ok.body.reasonCode).toBe("against_policy");
    }

    // Unchanged draft is never blocked by require_reason
    const unchanged = decideOnSend({
      ...base,
      settings,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    expect(unchanged.action).toBe("capture");
    if (unchanged.action === "capture") {
      expect(unchanged.changed).toBe(false);
    }
  });

  it("decision fields ride along and a changed field is detected as a change", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [
        { id: "order_status", label: "status" },
        { id: "refund_amount", label: "refund" },
      ],
    };

    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_answer",
      draftFields: { status: "pending", refund: 48.5 },
      send: {
        text: draftText,
        type: "publicReply",
        fields: { status: "refunded", refund: 48.5 },
      },
    });

    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "pending", refund: 48.5 });
    expect(d.body.sent.fields).toEqual({ status: "refunded", refund: 48.5 });
  });

  it("records how long the draft sat in front of the reviewer in secondsToSend", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "inserted", at: 10_000 },
      now: 16_500,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(6.5);
  });

  it("attaches to a recorded draft run when available", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1000,
      },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
  });
});

describe("statusLine", () => {
  it("describes the various draft and capture states", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three four", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 4 words",
    );
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine({ text: "order confirmed", origin: "preloaded", at: 1 }, null)).toBe(
      "Draft found in the composer · 2 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: false })).toBe(
      "Captured · edit saved as a case",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });
});
