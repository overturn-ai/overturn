import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  draftTag,
  findAiDraft,
  findSentReply,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "conv_48213",
  subject: "Roof leak after storm",
  contactEmail: "dana@example.com",
  contactName: "Dana",
  parts: [
    {
      id: "part_1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      partType: "comment",
      authorEmail: "dana@example.com",
      authorType: "user",
      createdAt: "2026-10-01T10:00:00Z",
    },
    {
      id: "part_2",
      body: "HO-3, no prior claims.",
      partType: "note",
      authorName: "Ray",
      authorType: "admin",
    },
  ],
  fields: {},
  url: null,
};

describe("settings", () => {
  it("parses the app configuration", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      decision_fields: "coverage_amount:coverage, reserve_amount:reserve,reserve_note",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "coverage_amount", label: "coverage" },
      { id: "reserve_amount", label: "reserve" },
      { id: "reserve_note", label: "reserve_note" },
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

  it("reason_pack picks the options: support by default, claims when a claims team opts in", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain(
      "wrong_coverage_decision",
    );
    const support = settingsFrom({});
    const codes = quickReasons(support).map((r) => r.code);
    expect(codes).toContain("wrong_answer");
    expect(codes).toContain("should_escalate");
    expect(codes).not.toContain("reserve_too_low");
    // both packs keep tone/wording so the suite exclusion applies to either
    expect(codes).toContain("tone_wording");
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("falls back to defaults, with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
  });
});

describe("draft origin", () => {
  it("tags only the origins we were told: ai and recorded as draft:ai, manual as draft:manual, unknown as nothing", () => {
    expect(draftTag("ai")).toBe("draft:ai");
    expect(draftTag("recorded")).toBe("draft:ai");
    expect(draftTag("manual")).toBe("draft:manual");
    expect(draftTag("unknown")).toBeNull();
  });

  it("a Fin part waiting at the end of the thread is the AI draft", () => {
    const withFin: ConversationSnapshot = {
      ...conversation,
      parts: [
        ...conversation.parts,
        {
          id: "part_3",
          body: draftText,
          partType: "comment",
          authorName: "Fin",
          authorType: "bot",
          createdAt: "2026-10-01T10:05:00Z",
        },
      ],
    };
    const d = findAiDraft(withFin);
    expect(d?.origin).toBe("ai");
    expect(d?.partId).toBe("part_3");
    expect(d?.text).toContain("Storm damage to the roof is covered");
    expect(d?.at).toBe(Date.parse("2026-10-01T10:05:00Z"));
  });

  it("no AI draft once the expert has answered, or when the newest part is not Fin's", () => {
    expect(findAiDraft(conversation)).toBeNull();
    const answered: ConversationSnapshot = {
      ...conversation,
      parts: [
        ...conversation.parts,
        { id: "part_3", body: draftText, partType: "comment", authorType: "bot" },
        { id: "part_4", body: "Sent my own reply.", partType: "comment", authorType: "admin" },
      ],
    };
    expect(findAiDraft(answered)).toBeNull();
    const finNote: ConversationSnapshot = {
      ...conversation,
      parts: [...conversation.parts, { id: "part_3", body: draftText, partType: "note", authorType: "bot" }],
    };
    expect(findAiDraft(finNote)).toBeNull();
  });

  it("the sent reply is the newest teammate comment after the draft; notes are not sends", () => {
    const draft = { text: draftText, origin: "ai" as const, partId: "part_3", at: 1 };
    const thread: ConversationSnapshot = {
      ...conversation,
      parts: [
        ...conversation.parts,
        { id: "part_3", body: draftText, partType: "comment", authorType: "bot" },
        { id: "part_4", body: "internal: checking the SLA", partType: "note", authorType: "admin" },
      ],
    };
    expect(findSentReply(thread, draft)).toBeNull();
    const sent: ConversationSnapshot = {
      ...thread,
      parts: [
        ...thread.parts,
        { id: "part_5", body: "<p>Adjusted reply.</p>", partType: "comment", authorType: "admin" },
      ],
    };
    expect(findSentReply(sent, draft)).toEqual({ text: "Adjusted reply.", partId: "part_5" });
  });
});

describe("context and html", () => {
  it("strips html and maps roles: customer, teammate and Fin as agent-side, notes as notes", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00Z",
      },
      { role: "note", author: "Ray", content: "HO-3, no prior claims.", at: null },
    ]);
    const finThread: ConversationSnapshot = {
      ...conversation,
      parts: [
        ...conversation.parts,
        { id: "p9", body: "Draft text", partType: "comment", authorType: "bot" },
      ],
    };
    expect(contextFrom(finThread)[2]?.role).toBe("agent");
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
    // The claims pack requires a reason by default; most cases here test the capture shape, so relax it.
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft, on internal notes, and on empty sends", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "x", type: "reply", fields: {} } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, send: { text: "x", type: "note", fields: {} } })).toEqual({
      action: "skip",
      why: "internal-note",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>", type: "reply", fields: {} } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("sending the draft unchanged is an approve capture, valid against the shared contract", () => {
    const d = decideOnSend({ ...base, now: 60_000, send: { text: draftText, type: "reply", fields: {} } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:conv_48213");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(typeof d.body.secondsToSend).toBe("number");
    expect(d.body.context).toHaveLength(2);
    expect(d.body.metadata).toEqual({ contact: "dana@example.com" });
    expect(captureCreateSchema.parse(d.body).source).toBe("intercom");
  });

  it("a hand-marked draft is tagged draft:manual; an origin nobody stated carries no draft tag", () => {
    const manual = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "manual", at: 1 },
      send: { text: draftText, type: "reply", fields: {} },
    });
    if (manual.action !== "capture") throw new Error(manual.action);
    expect(manual.body.tags).toEqual(["draft:manual", "public-reply"]);
    const unknown = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "unknown", at: 1 },
      send: { text: draftText, type: "reply", fields: {} },
    });
    if (unknown.action !== "capture") throw new Error(unknown.action);
    expect(unknown.body.tags).toEqual(["public-reply"]);
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Storm SLA is 2 days",
      send: { text: sent, type: "reply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason (the default) holds a changed capture until a reason code is picked; a note alone is not enough", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("covered", "not covered");
    const blocked = decideOnSend({
      ...base,
      settings,
      send: { text: sent, type: "reply", fields: {} },
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });
    const noteOnly = decideOnSend({
      ...base,
      settings,
      reason: "exclusion",
      send: { text: sent, type: "reply", fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");
    const ok = decideOnSend({
      ...base,
      settings,
      reasonCode: "missed_exclusion",
      send: { text: sent, type: "reply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("missed_exclusion");
    const unchanged = decideOnSend({
      ...base,
      settings,
      send: { text: draftText, type: "reply", fields: {} },
    });
    expect(unchanged.action).toBe("capture");
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = { ...DEFAULT_SETTINGS, decisionFields: [{ id: "status_attr", label: "status" }] };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_coverage_decision",
      draftFields: { status: "covered" },
      send: { text: draftText, type: "reply", fields: { status: "denied" } },
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
      draft: { text: draftText, origin: "ai", at: 10_000 },
      now: 14_250,
      send: { text: draftText, type: "reply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("a recorded draft attaches to its run and still counts as an AI draft", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1,
      },
      send: { text: draftText, type: "reply", fields: {} },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
    expect(d.body.tags).toEqual(["draft:ai", "public-reply"]);
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine({ text: "one two three", origin: "unknown", at: 1 }, null)).toBe("Draft · 3 words");
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });

  it("shows the inserted draft the way the bounty spec words it", () => {
    const words = Array.from({ length: 112 }, () => "word").join(" ");
    expect(statusLine({ text: words, origin: "ai", at: 1 }, null)).toBe("Draft inserted · 112 words");
  });
});
