import { describe, expect, it } from "vitest";
import {
  type ConversationSnapshot,
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  type FrontMessage,
  inScope,
  newlySent,
  quickReasons,
  sameReply,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<div>Hi Dana,<br><br>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</div>";

const conversation: ConversationSnapshot = {
  id: "cnv_55c8c149",
  subject: "Roof leak after storm",
  recipientEmail: "dana@example.com",
  recipientName: "Dana",
  tags: ["billing"],
  messages: [
    {
      id: "msg_1",
      body: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      status: "inbound",
      author: "dana@example.com",
      at: "2026-10-01T10:00:00Z",
    },
    {
      id: "msg_2",
      body: "<div>HO-3, no prior claims.</div>",
      status: "outbound",
      author: "ray@carrier.com",
      at: "2026-10-01T10:05:00Z",
    },
  ],
  comments: [{ id: "cmt_1", body: "Check the deductible before quoting.", author: "Ray", at: null }],
  fields: {},
  url: "https://app.frontapp.com/open/cnv_55c8c149",
};

const draft = { text: draftText, origin: "inserted" as const, at: Date.parse("2026-10-01T10:10:00Z") };

describe("settings", () => {
  it("parses the plugin URL parameters", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "false",
      decision_fields: "coverage, reserve,,denial_reason",
      min_draft_chars: "120",
      scope_tag: "ai_drafted",
      reason_pack: "claims",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(false);
    expect(s.decisionFields).toEqual(["coverage", "reserve", "denial_reason"]);
    expect(s.minDraftChars).toBe(120);
    expect(s.scopeTag).toBe("ai_drafted");
    expect(s.reasonPack).toBe("claims");
  });

  it("falls back to defaults, with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(settingsFrom({ require_reason: "true" }).requireReason).toBe(true);
    expect(settingsFrom({ min_draft_chars: "0" }).minDraftChars).toBe(DEFAULT_SETTINGS.minDraftChars);
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("a scope tag limits which conversations are read at all", () => {
    expect(inScope([], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(inScope(conversation.tags, scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the chips", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    const claims = quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code);
    expect(claims).toContain("wrong_coverage_decision");
    expect(claims).toContain("tone_wording");
    expect(claims).not.toContain("should_escalate");
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("a reply-sized insert into an empty composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", 0)).toBeNull();
    let typed = "";
    for (let i = 1; i <= 100; i++) {
      typed += "ab";
      expect(d.onComposer(typed, i * 100)).toBeNull();
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

  it("a paste after a pause while a greeting was typed still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    d.onComposer("Hi Dana,", 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, 9000)?.origin).toBe("inserted");
  });
});

describe("context", () => {
  it("strips html and maps roles by message status", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the ceiling.\nPhotos attached.",
        at: "2026-10-01T10:00:00Z",
      },
      {
        role: "agent",
        author: "ray@carrier.com",
        content: "HO-3, no prior claims.",
        at: "2026-10-01T10:05:00Z",
      },
      { role: "note", author: "Ray", content: "Check the deductible before quoting.", at: null },
    ]);
  });

  it("comments can be left out of the context", () => {
    expect(contextFrom(conversation, false).some((m) => m.role === "note")).toBe(false);
  });
});

describe("send detection", () => {
  const sent: FrontMessage = {
    id: "msg_3",
    body: "<div>Hi Dana,<br><br>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 2 business days.</div>",
    status: "outbound",
    at: "2026-10-01T10:12:00Z",
  };

  it("matches the outbound message the draft became", () => {
    expect(newlySent([...conversation.messages, sent], { draftText, draftAt: draft.at })).toEqual(sent);
  });

  it("tolerates an appended signature", () => {
    const signed = { ...sent, body: `${draftText}<div>--<br>Ray<br>Carrier Claims</div>` };
    expect(newlySent([...conversation.messages, signed], { draftText, draftAt: draft.at })?.id).toBe("msg_3");
  });

  it("ignores inbound messages, seen messages and old ones", () => {
    const inbound = { ...sent, id: "msg_4", status: "inbound" };
    expect(newlySent([...conversation.messages, inbound], { draftText, draftAt: draft.at })).toBeNull();
    expect(newlySent([sent], { draftText, draftAt: draft.at, seenIds: ["msg_3"] })).toBeNull();
    const old = { ...sent, at: "2026-09-01T10:00:00Z" };
    expect(newlySent([old], { draftText, draftAt: draft.at })).toBeNull();
  });

  it("skips when two fresh outbound replies are ambiguous, and prefers the one that matches", () => {
    const other: FrontMessage = { ...sent, id: "msg_5", body: "<div>Unrelated follow-up.</div>" };
    const another: FrontMessage = { ...sent, id: "msg_6", body: "<div>Something else entirely.</div>" };
    expect(newlySent([other, another], { draftText, draftAt: draft.at })).toBeNull();
    expect(newlySent([other, sent, another], { draftText, draftAt: draft.at })?.id).toBe("msg_3");
  });

  it("sameReply anchors on the opening of the draft", () => {
    expect(sameReply(draftText, draftText)).toBe(true);
    expect(sameReply(draftText, "<div>Thanks, Dana</div>")).toBe(false);
    expect(sameReply("<div>a</div>", "<div></div>")).toBe(false);
  });
});

describe("capture payload", () => {
  const sent = {
    text: draftText.replace("5 business days", "2 business days"),
    fields: {},
  };

  it("an unchanged send needs no reason and is recorded as approved", () => {
    const d = decideOnSend({
      conversation,
      draft,
      draftFields: {},
      sent: { text: draftText },
      reasonCode: null,
      reason: "",
      actor: "ray@carrier.com",
      settings: DEFAULT_SETTINGS,
      now: draft.at + 120_000,
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body).toMatchObject({
      source: "front",
      externalId: "fr:cnv_55c8c149",
      agent: "support-reply",
      actor: "ray@carrier.com",
      subject: "Roof leak after storm",
      reason: null,
      reasonCode: null,
      secondsToSend: 120,
      tags: ["draft:inserted", "outbound-reply"],
      metadata: { recipient: "dana@example.com" },
    });
  });

  it("a changed send is refused until a reason is picked", () => {
    const blocked = decideOnSend({
      conversation,
      draft,
      draftFields: {},
      sent,
      reasonCode: null,
      reason: "2-day SLA for storm claims",
      actor: "ray@carrier.com",
      settings: DEFAULT_SETTINGS,
    });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });

    const kept = decideOnSend({
      conversation,
      draft,
      draftFields: {},
      sent,
      reasonCode: "wrong_amount_or_date",
      reason: "2-day SLA for storm claims",
      actor: "ray@carrier.com",
      settings: DEFAULT_SETTINGS,
    });
    expect(kept.action).toBe("capture");
    if (kept.action !== "capture") return;
    expect(kept.changed).toBe(true);
    expect(kept.changedFields).toEqual([]);
    expect(kept.body.reasonCode).toBe("wrong_amount_or_date");
    expect(kept.body.reason).toBe("2-day SLA for storm claims");
    expect(kept.body.sent.text).toContain("2 business days");
  });

  it("with require_reason off a changed send goes through without a code", () => {
    const d = decideOnSend({
      conversation,
      draft,
      draftFields: {},
      sent,
      reasonCode: null,
      reason: "",
      actor: "ray@carrier.com",
      settings: settingsFrom({ require_reason: "false" }),
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.body.reasonCode).toBeNull();
  });

  it("never records a send with no draft, or an empty one", () => {
    expect(
      decideOnSend({
        conversation,
        draft: null,
        draftFields: {},
        sent,
        reasonCode: null,
        reason: "",
        actor: null,
        settings: DEFAULT_SETTINGS,
      }),
    ).toEqual({ action: "skip", why: "no-draft" });
    expect(
      decideOnSend({
        conversation,
        draft,
        draftFields: {},
        sent: { text: "<div> </div>" },
        reasonCode: null,
        reason: "",
        actor: null,
        settings: DEFAULT_SETTINGS,
      }),
    ).toEqual({ action: "skip", why: "empty" });
  });

  it("scored decision fields ride along when an admin maps them", () => {
    const settings = settingsFrom({ decision_fields: "coverage,reserve" });
    const d = decideOnSend({
      conversation: { ...conversation, fields: { coverage: "covered", reserve: 6500 } },
      draft,
      draftFields: { coverage: "covered", reserve: 4000 },
      sent: { text: draftText, fields: { coverage: "covered", reserve: 6500 } },
      reasonCode: "reserve_too_low",
      reason: "roof replacement, not repair",
      actor: "ray@carrier.com",
      settings,
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changedFields).toEqual(["reserve"]);
    expect(d.body.draft.fields).toEqual({ coverage: "covered", reserve: 4000 });
    expect(d.body.sent.fields).toEqual({ coverage: "covered", reserve: 6500 });
  });
});

describe("status", () => {
  it("says what it is waiting for, and what it did", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine(draft, null)).toBe("Draft inserted · 25 words");
    expect(statusLine(draft, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(draft, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });
});
