import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  type FrontSdkComment,
  type FrontSdkConversation,
  type FrontSdkMessage,
  inScope,
  quickReasons,
  settingsFrom,
  snapshotFromFront,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "cnv_48213",
  subject: "Roof leak after storm",
  recipientEmail: "dana@example.com",
  recipientName: "Dana",
  messages: [
    {
      id: "msg_1",
      value: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      type: "inbound",
      authorEmail: "dana@example.com",
      isOutbound: false,
      isAgent: false,
      createdAt: "2026-10-01T10:00:00Z",
    },
    {
      id: "comment_2",
      value: "HO-3, no prior claims.",
      type: "internalNote",
      authorName: "Ray",
      isOutbound: true,
      isAgent: true,
      createdAt: "2026-10-01T10:05:00Z",
    },
  ],
  fields: {},
  url: "https://app.frontapp.com/open/cnv_48213",
};

describe("settings", () => {
  it("parses the manifest parameters and options", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      overturn_api_key: "ov_live_secretkey",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "custom_field_1:status, custom_field_2:reserve,custom_field_3",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.apiKey).toBe("ov_live_secretkey");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "custom_field_1", label: "status" },
      { id: "custom_field_2", label: "reserve" },
      { id: "custom_field_3", label: "custom_field_3" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("supports camelCase settings keys from Front preferences", () => {
    const s = settingsFrom({
      baseUrl: "https://ov.internal/",
      apiKey: "key_123",
      requireReason: false,
      decisionFields: "reserve:Reserve",
      minDraftChars: 50,
      scopeTag: "claims",
      reasonPack: "claims",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.apiKey).toBe("key_123");
    expect(s.requireReason).toBe(false);
    expect(s.decisionFields).toEqual([{ id: "reserve", label: "Reserve" }]);
    expect(s.minDraftChars).toBe(50);
    expect(s.scopeTag).toBe("claims");
    expect(s.reasonPack).toBe("claims");
  });

  it("a scope tag limits which conversations are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(scoped.scopeTag).toBe("ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the chips: support by default, claims when a claims team opts in", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain(
      "wrong_coverage_decision",
    );
    const support = settingsFrom({});
    const codes = quickReasons(support).map((r) => r.code);
    expect(codes).toContain("wrong_answer");
    expect(codes).toContain("should_escalate");
    expect(codes).not.toContain("reserve_too_low");
    expect(codes).toContain("tone_wording");
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("falls back to defaults, with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("a reply-sized insert into an empty composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", 0);
    expect(d2.onComposer(long, 500)?.origin).toBe("inserted");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull(); // only the first
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
  it("strips html and maps roles for Front conversation", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00Z",
      },
      {
        role: "note",
        author: "Ray",
        content: "HO-3, no prior claims.",
        at: "2026-10-01T10:05:00Z",
      },
    ]);
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1 };
  const base = {
    conversation,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft, on internal notes, and on empty sends", () => {
    expect(
      decideOnSend({ ...base, draft: null, send: { text: "x", type: "publicReply", fields: {} } }),
    ).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: { text: "x", type: "internalNote", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", type: "publicReply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("sending the draft unchanged is an approve capture with source front and fr:<id>", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_48213");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(typeof d.body.secondsToSend).toBe("number");
    expect(d.body.context).toHaveLength(2);
    expect(d.body.url).toBe("https://app.frontapp.com/open/cnv_48213");
    expect(d.body.metadata).toEqual({ recipient: "dana@example.com" });
  });

  it("a changed reply is an edit capture carrying the reason and reasonCode", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Storm SLA is 2 days",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_48213");
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason (the default) blocks a changed send until a reason code is picked; a note alone is not enough", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("covered", "not covered");
    const blocked = decideOnSend({
      ...base,
      settings,
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });
    const noteOnly = decideOnSend({
      ...base,
      settings,
      reason: "exclusion",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");
    const ok = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_coverage_decision",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("wrong_coverage_decision");
    const unchanged = decideOnSend({
      ...base,
      settings,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    expect(unchanged.action).toBe("capture");
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = { ...DEFAULT_SETTINGS, decisionFields: [{ id: "custom_field_1", label: "status" }] };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_coverage_decision",
      draftFields: { status: "covered" },
      send: { text: draftText, type: "publicReply", fields: { status: "denied" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "covered" });
    expect(d.body.sent.fields).toEqual({ status: "denied" });
  });

  it("records how long the draft sat in front of the expert", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "inserted", at: 10_000 },
      now: 14_250,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("a recorded draft attaches to its run", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1,
      },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine({ text: "one two", origin: "recorded", at: 1 }, null)).toBe(
      "Draft recorded by your agent · 2 words",
    );
    expect(statusLine({ text: "four five six seven", origin: "preloaded", at: 1 }, null)).toBe(
      "Draft found in the composer · 4 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: false })).toBe(
      "Captured · edit saved as a case",
    );
  });
});

describe("Front SDK adapter: snapshotFromFront", () => {
  it("converts Front SDK conversation, messages, and comments to ConversationSnapshot", () => {
    const frontConv: FrontSdkConversation = {
      id: "cnv_test_99",
      subject: "Test coverage",
      recipient: { handle: "customer@test.com", name: "Cust Test" },
      tags: [{ id: "tag_1", name: "urgent" }],
      customFieldAttributes: [
        { id: "cf_status", name: "coverage_status", value: "pending" },
        { id: "cf_reserve", name: "reserve_amount", value: 5000 },
      ],
    };

    const frontMsgs: FrontSdkMessage[] = [
      {
        id: "msg_1",
        subject: "Claim inquiry",
        date: "2026-10-01T09:00:00Z",
        status: "inbound",
        content: { body: "Here is my claim.", type: "text" },
        from: { handle: "customer@test.com", name: "Cust Test" },
      },
      {
        id: "msg_2",
        subject: "Claim inquiry",
        date: "2026-10-01T09:30:00Z",
        status: "outbound",
        content: { body: "<p>We are reviewing it.</p>", type: "html" },
        from: { handle: "adjuster@company.com", name: "Adjuster" },
      },
    ];

    const frontComments: FrontSdkComment[] = [
      {
        id: "comment_1",
        body: "Internal note: review policy schedule.",
        date: "2026-10-01T09:15:00Z",
        author: { email: "supervisor@company.com", name: "Supervisor" },
      },
    ];

    const snap = snapshotFromFront(frontConv, frontMsgs, frontComments);
    expect(snap.id).toBe("cnv_test_99");
    expect(snap.subject).toBe("Test coverage");
    expect(snap.recipientEmail).toBe("customer@test.com");
    expect(snap.recipientName).toBe("Cust Test");
    expect(snap.url).toBe("https://app.frontapp.com/open/cnv_test_99");
    expect(snap.fields.coverage_status).toBe("pending");
    expect(snap.fields.reserve_amount).toBe(5000);

    // Messages should be ordered oldest first: msg_1 (09:00), comment_1 (09:15), msg_2 (09:30)
    expect(snap.messages).toHaveLength(3);
    expect(snap.messages?.[0]?.id).toBe("msg_1");
    expect(snap.messages?.[0]?.isOutbound).toBe(false);
    expect(snap.messages?.[1]?.id).toBe("comment_1");
    expect(snap.messages?.[1]?.type).toBe("internalNote");
    expect(snap.messages?.[2]?.id).toBe("msg_2");
    expect(snap.messages?.[2]?.isOutbound).toBe(true);

    const ctx = contextFrom(snap);
    expect(ctx).toEqual([
      {
        role: "customer",
        author: "customer@test.com",
        content: "Here is my claim.",
        at: "2026-10-01T09:00:00Z",
      },
      {
        role: "note",
        author: "supervisor@company.com",
        content: "Internal note: review policy schedule.",
        at: "2026-10-01T09:15:00Z",
      },
      {
        role: "agent",
        author: "adjuster@company.com",
        content: "We are reviewing it.",
        at: "2026-10-01T09:30:00Z",
      },
    ]);
  });
});
