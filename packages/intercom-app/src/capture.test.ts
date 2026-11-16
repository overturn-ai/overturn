import { describe, expect, it, vi } from "vitest";
import {
  buildCanvas,
  type ConversationSnapshot,
  contextFrom,
  conversationSnapshotFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  draftTagFrom,
  executeCapture,
  formatTimestamp,
  inScope,
  quickReasons,
  roleFromIntercom,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture.js";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for reaching out. We have processed your claim under your active policy. A claims specialist will follow up within 2 business days.</p>";

const conversation: ConversationSnapshot = {
  id: 10482,
  subject: "Water damage question",
  customerEmail: "dana@example.com",
  customerName: "Dana",
  parts: [
    {
      id: 1,
      body: "<div>Water came through the roof.<br>Photos attached.</div>",
      partType: "comment",
      authorEmail: "dana@example.com",
      authorRole: "user",
      createdAt: "2026-10-01T10:00:00Z",
    },
    {
      id: 2,
      body: "HO-3 policy, deductible verified.",
      partType: "note",
      authorName: "Ray",
      authorRole: "admin",
      createdAt: 1727777000,
    },
    {
      id: 3,
      body: "<p>Fin assist suggested reply: check policy clause 4.</p>",
      partType: "comment",
      authorRole: "bot",
      createdAt: 1727777100,
    },
  ],
  fields: {},
  url: "https://app.intercom.com/a/inbox/conversation/10482",
};

describe("settings", () => {
  it("parses the manifest parameters and config", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "custom_field_1:status, custom_field_2:reserve,custom_field_3",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "custom_field_1", label: "status" },
      { id: "custom_field_2", label: "reserve" },
      { id: "custom_field_3", label: "custom_field_3" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("a scope tag limits which conversations are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(scoped.scopeTag).toBe("ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the chips: support by default, claims when opted in", () => {
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
    expect(settingsFrom({ reason_pack: "invalid_pack" }).reasonPack).toBe("support");
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
    expect(d2.onComposer(long, 500)?.origin).toBe("ai");
    expect(d2.onComposer(`${long} more`, 600)).toBeNull(); // only the first draft
  });

  it("a composer that already holds a reply on load is an ai draft", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("ai");
  });

  it("a paste after a pause while a short greeting was typed still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("ai");
  });

  it("honours explicit origin and isAi flags", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 0, { origin: "manual" })?.origin).toBe("manual");

    const d2 = createDraftDetector({ minDraftChars: 80 });
    expect(d2.onComposer(long, 0, { isAi: true })?.origin).toBe("ai");

    const d3 = createDraftDetector({ minDraftChars: 80 });
    expect(d3.onComposer(long, 0, { isAi: false })?.origin).toBe("manual");
  });
});

describe("context, roles and html", () => {
  it("strips html and maps roles", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(roleFromIntercom("note")).toBe("note");
    expect(roleFromIntercom("comment", "admin")).toBe("agent");
    expect(roleFromIntercom("comment", "bot")).toBe("agent");
    expect(roleFromIntercom("comment", "user")).toBe("customer");
    expect(roleFromIntercom("comment", "lead")).toBe("customer");
  });

  it("formats timestamps from numbers and strings", () => {
    expect(formatTimestamp(null)).toBeNull();
    expect(formatTimestamp(1727777000)).toBe(new Date(1727777000 * 1000).toISOString());
    expect(formatTimestamp("2026-10-01T10:00:00Z")).toBe("2026-10-01T10:00:00Z");
  });

  it("builds context with correct roles, author names and dates", () => {
    const ctx = contextFrom(conversation);
    expect(ctx).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the roof.\nPhotos attached.",
        at: "2026-10-01T10:00:00Z",
      },
      {
        role: "note",
        author: "Ray",
        content: "HO-3 policy, deductible verified.",
        at: new Date(1727777000 * 1000).toISOString(),
      },
      {
        role: "agent",
        author: "Fin",
        content: "Fin assist suggested reply: check policy clause 4.",
        at: new Date(1727777100 * 1000).toISOString(),
      },
    ]);
  });

  it("parses raw Intercom conversation objects", () => {
    const raw = {
      id: "ic_999",
      subject: "Billing question",
      source: {
        body: "<p>Can I get an invoice?</p>",
        author: { type: "user", email: "user@corp.com", name: "User" },
        created_at: 1727770000,
      },
      conversation_parts: {
        conversation_parts: [
          {
            part_type: "comment",
            body: "<p>Sure, attached.</p>",
            author: { type: "admin", email: "admin@corp.com", name: "Agent" },
            created_at: 1727770100,
          },
        ],
      },
      custom_attributes: {
        priority: "high",
      },
    };
    const snap = conversationSnapshotFrom(raw);
    expect(snap.id).toBe("ic_999");
    expect(snap.customerEmail).toBe("user@corp.com");
    expect(snap.parts).toHaveLength(2);
    expect(snap.fields).toEqual({ priority: "high" });
    expect(contextFrom(snap)).toHaveLength(2);
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "ai" as const, at: 1 };
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

  it("sending the draft unchanged is an approve capture with draft:ai tag", () => {
    const d = decideOnSend({ ...base, send: { text: draftText, type: "publicReply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:10482");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(typeof d.body.secondsToSend).toBe("number");
    expect(d.body.context).toHaveLength(3);
  });

  it("distinguishes draft origins: tag draft:ai only for assists, draft:manual when typed, neither for unknown", () => {
    // 1. AI assist draft
    const aiSend = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "ai", at: 1 },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (aiSend.action !== "capture") throw new Error(aiSend.action);
    expect(aiSend.body.tags).toContain("draft:ai");
    expect(aiSend.body.tags).not.toContain("draft:manual");

    // 2. Manual human draft
    const manualSend = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "manual", at: 1 },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (manualSend.action !== "capture") throw new Error(manualSend.action);
    expect(manualSend.body.tags).toContain("draft:manual");
    expect(manualSend.body.tags).not.toContain("draft:ai");

    // 3. Unknown origin: does not guess an origin we were not told
    const unknownSend = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "unknown", at: 1 },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (unknownSend.action !== "capture") throw new Error(unknownSend.action);
    expect(unknownSend.body.tags).not.toContain("draft:ai");
    expect(unknownSend.body.tags).not.toContain("draft:manual");
    expect(unknownSend.body.tags).toEqual(["public-reply"]);
  });

  it("draftTagFrom maps origins correctly", () => {
    expect(draftTagFrom("ai")).toBe("draft:ai");
    expect(draftTagFrom("inserted")).toBe("draft:ai");
    expect(draftTagFrom("recorded")).toBe("draft:ai");
    expect(draftTagFrom("preloaded")).toBe("draft:ai");
    expect(draftTagFrom("manual")).toBe("draft:manual");
    expect(draftTagFrom("unknown")).toBeNull();
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("2 business days", "5 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Holiday weekend: SLA is 5 days",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Holiday weekend: SLA is 5 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("5 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason blocks a changed send until a reason code is picked; a note alone is not enough", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("active policy", "expired policy");

    const blocked = decideOnSend({
      ...base,
      settings,
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });

    const noteOnly = decideOnSend({
      ...base,
      settings,
      reason: "Policy expired",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");

    const ok = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_answer",
      send: { text: sent, type: "publicReply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("wrong_answer");

    const unchanged = decideOnSend({
      ...base,
      settings,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    expect(unchanged.action).toBe("capture");
  });

  it("decision fields ride along and a changed field is detected as a change", () => {
    const settings = { ...DEFAULT_SETTINGS, decisionFields: [{ id: "custom_field_1", label: "status" }] };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_answer",
      draftFields: { status: "pending" },
      send: { text: draftText, type: "publicReply", fields: { status: "approved" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "pending" });
    expect(d.body.sent.fields).toEqual({ status: "approved" });
  });

  it("records how long the draft sat in front of the teammate", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "ai", at: 10_000 },
      now: 14_250,
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("attaches recorded draft runId and model when available", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "fin-v2",
        at: 1,
      },
      send: { text: draftText, type: "publicReply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("fin-v2");
    expect(d.body.tags).toContain("draft:ai");
  });
});

describe("statusLine", () => {
  it("describes the draft and result states", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "ai", at: 1 }, null)).toBe("Draft inserted · 3 words");
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
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

describe("buildCanvas", () => {
  it("builds Canvas Kit response with status, dropdown, textarea and buttons", () => {
    const canvas = buildCanvas({
      draft: { text: "Hello Dana, we received your inquiry.", origin: "ai", at: 1000 },
      settings: DEFAULT_SETTINGS,
      selectedReasonCode: "wrong_answer",
      reasonNote: "Typo fix",
    });

    const components = canvas.canvas.content.components;
    expect(components).toBeDefined();

    // Status text
    const statusComp = components.find((c) => c.id === "status_text");
    expect(statusComp).toBeDefined();
    expect(statusComp?.type).toBe("text");
    if (statusComp?.type === "text") {
      expect(statusComp.text).toContain("Draft inserted · 6 words");
    }

    // Reason dropdown
    const reasonComp = components.find((c) => c.id === "reason_code");
    expect(reasonComp).toBeDefined();
    expect(reasonComp?.type).toBe("dropdown");
    if (reasonComp?.type === "dropdown") {
      expect(reasonComp.options.map((o) => o.id)).toContain("wrong_answer");
      expect(reasonComp.value).toBe("wrong_answer");
    }

    // Note textarea
    const noteComp = components.find((c) => c.id === "reason_note");
    expect(noteComp).toBeDefined();
    expect(noteComp?.type).toBe("textarea");
    if (noteComp?.type === "textarea") {
      expect(noteComp.value).toBe("Typo fix");
    }

    // Save Reason button
    const saveBtn = components.find((c) => c.id === "save_reason");
    expect(saveBtn).toBeDefined();
    expect(saveBtn?.type).toBe("button");

    // stored_data persistence
    expect(canvas.canvas.stored_data?.reasonCode).toBe("wrong_answer");
    expect(canvas.canvas.stored_data?.reasonNote).toBe("Typo fix");
  });

  it("shows need_reason_alert when reason is required", () => {
    const canvas = buildCanvas({
      draft: { text: "Short text", origin: "ai", at: 1000 },
      settings: DEFAULT_SETTINGS,
      needsReason: true,
    });
    const alert = canvas.canvas.content.components.find((c) => c.id === "need_reason_alert");
    expect(alert).toBeDefined();
    if (alert?.type === "text") {
      expect(alert.text).toContain("Please pick why you changed the reply");
    }
  });
});

describe("executeCapture", () => {
  it("executes POST /v1/capture on action capture", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        kind: "edit",
        changed: true,
        changedFields: [],
        deduplicated: false,
        correction: { id: "c1" },
        case: { id: "case_1", title: "Edited reply" },
      }),
    });

    const decision = decideOnSend({
      conversation,
      draft: { text: draftText, origin: "ai", at: 1000 },
      send: { text: "Changed text", type: "publicReply", fields: {} },
      reasonCode: "wrong_answer",
      reason: "Incorrect",
      actor: "agent@corp.com",
      settings: { ...DEFAULT_SETTINGS, requireReason: false },
    });

    const result = await executeCapture({
      decision,
      settings: DEFAULT_SETTINGS,
      apiKey: "ov_test_key",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.overturn.run/v1/capture",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer ov_test_key",
        }),
      }),
    );
    expect(result?.kind).toBe("edit");
    expect(result?.case?.title).toBe("Edited reply");
  });

  it("never blocks the send: returns null on network or server error", async () => {
    const mockFailingFetch = vi.fn().mockRejectedValue(new Error("Network offline"));

    const decision = decideOnSend({
      conversation,
      draft: { text: draftText, origin: "ai", at: 1000 },
      send: { text: "Changed text", type: "publicReply", fields: {} },
      reasonCode: "wrong_answer",
      actor: "agent@corp.com",
      settings: { ...DEFAULT_SETTINGS, requireReason: false },
    });

    const result = await executeCapture({
      decision,
      settings: DEFAULT_SETTINGS,
      apiKey: "ov_test_key",
      fetchFn: mockFailingFetch as unknown as typeof fetch,
    });

    expect(result).toBeNull();
  });
});
