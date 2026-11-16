import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const conversation: ConversationSnapshot = {
  id: "cnv_8f2k",
  subject: "Roof leak after storm",
  recipient: "dana@example.com",
  messages: [
    {
      id: "msg_1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      isInbound: true,
      authorEmail: "dana@example.com",
      createdAt: "2026-10-01T10:00:00Z",
    },
  ],
  comments: [{ id: "cmt_1", body: "HO-3, no prior claims.", authorName: "Ray" }],
  url: "https://app.frontapp.com/open/cnv_8f2k",
};

describe("settings", () => {
  it("parses the config", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      min_draft_chars: "120",
      reason_pack: "claims",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(true);
    expect(s.minDraftChars).toBe(120);
    expect(s.reasonPack).toBe("claims");
  });

  it("falls back to defaults, with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
    expect(settingsFrom({ min_draft_chars: "nope" }).minDraftChars).toBe(80);
  });

  it("reason_pack picks the chips: support by default, claims when opted in", () => {
    const support = quickReasons(settingsFrom({})).map((r) => r.code);
    expect(support).toContain("wrong_answer");
    expect(support).toContain("tone_wording");
    expect(support).not.toContain("reserve_too_low");
    const claims = quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code);
    expect(claims).toHaveLength(8);
    expect(claims).toContain("wrong_coverage_decision");
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
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
    expect(d2.onComposer(`${long} more`, 600)).toBeNull();
  });
  it("a composer that already holds a reply on first sight is preloaded", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer(long, 10)?.origin).toBe("preloaded");
  });
});

describe("context and html", () => {
  it("strips html and maps roles", () => {
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
  });
  it("keeps only the latest 500 messages", () => {
    const messages = Array.from({ length: 600 }, (_, i) => ({
      id: `m${i}`,
      body: `message ${i}`,
      isInbound: true,
    }));
    const ctx = contextFrom({ ...conversation, messages, comments: [] });
    expect(ctx).toHaveLength(500);
    expect(ctx[499]?.content).toBe("message 599");
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1 };
  const base = {
    conversation,
    draft,
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@carrier.com",
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft and on empty sends", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "x" } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, send: { text: "<p> </p>" } })).toEqual({ action: "skip", why: "empty" });
  });

  it("sending the draft unchanged is an approve capture in the documented shape", () => {
    const d = decideOnSend({ ...base, send: { text: draftText } });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("front");
    expect(d.body.externalId).toBe("fr:cnv_8f2k");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.reasonCode).toBeNull();
    expect(d.body.tags).toEqual(["draft:inserted"]);
    expect(d.body.context).toHaveLength(2);
    expect(d.body.url).toBe("https://app.frontapp.com/open/cnv_8f2k");
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: " Storm SLA is 2 days ",
      send: { text: draftText.replace("5 business days", "2 business days") },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Storm SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("a changed reply without a code still captures when require_reason is off", () => {
    const d = decideOnSend({ ...base, send: { text: "Something else entirely." } });
    expect(d.action).toBe("capture");
  });

  it("require_reason blocks a changed send until a code is picked; a note alone is not enough", () => {
    const settings = DEFAULT_SETTINGS;
    const send = { text: draftText.replace("covered", "not covered") };
    expect(decideOnSend({ ...base, settings, send })).toEqual({ action: "need-reason", changedFields: [] });
    expect(decideOnSend({ ...base, settings, reason: "exclusion", send }).action).toBe("need-reason");
    const ok = decideOnSend({ ...base, settings, reasonCode: "wrong_answer", send });
    expect(ok.action).toBe("capture");
    expect(decideOnSend({ ...base, settings, send: { text: draftText } }).action).toBe("capture");
  });

  it("decision fields ride along and a changed field is a change", () => {
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_coverage_decision",
      draftFields: { status: "covered" },
      send: { text: draftText, fields: { status: "denied" } },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["status"]);
    expect(d.body.draft.fields).toEqual({ status: "covered" });
    expect(d.body.sent.fields).toEqual({ status: "denied" });
  });

  it("records how long the draft sat in front of the expert, rounded to 0.1s", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "inserted", at: 10_000 },
      now: 14_250,
      send: { text: draftText },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "<p>one two</p><p>three</p>", origin: "inserted", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft marked by you · 3 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });
});
