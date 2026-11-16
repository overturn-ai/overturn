import { describe, expect, it } from "vitest";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  draftOriginFrom,
  type IntercomConversation,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for your patience. Your refund was approved and will land on your card within 5 business days.</p>";

const conversation: IntercomConversation = {
  id: 42,
  title: "Where is my refund?",
  source: {
    type: "conversation",
    subject: "Refund status",
    body: "<p>Where is my refund? I was charged twice.</p>",
    author: { type: "user", name: "Dana", email: "dana@example.com" },
    created_at: 1_760_000_000,
  },
  conversation_parts: {
    conversation_parts: [
      {
        id: "p1",
        part_type: "comment",
        body: "<div>Let me check that for you.<br>One moment.</div>",
        author: { type: "admin", email: "ray@carrier.com" },
        created_at: 1_760_000_100,
      },
      {
        id: "p2",
        part_type: "note",
        body: "<p>Refund approved in Stripe.</p>",
        author: { type: "admin", name: "Ray" },
      },
      {
        id: "p3",
        part_type: "comment",
        body: "<p>Fin drafted a reply.</p>",
        author: { type: "bot", name: "Fin" },
      },
    ],
  },
  links: { conversation: "https://app.intercom.com/a/inbox/workspace/conversation/42" },
};

describe("settings", () => {
  it("parses the app's environment settings", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "claims-reply",
      require_reason: "true",
      reason_pack: "claims",
      decision_fields: "refund:Refund, reserve",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("claims-reply");
    expect(s.requireReason).toBe(true);
    expect(s.reasonPack).toBe("claims");
    expect(s.decisionFields).toEqual([
      { key: "refund", label: "Refund" },
      { key: "reserve", label: "reserve" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("defaults to the support pack, with require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.reasonPack).toBe("support");
    expect(settingsFrom({ require_reason: "false" }).requireReason).toBe(false);
    expect(settingsFrom({ reason_pack: "garbage" }).reasonPack).toBe("support");
  });

  it("offers the support codes by default and claims codes when a claims team opts in", () => {
    const support = quickReasons(DEFAULT_SETTINGS).map((r) => r.code);
    expect(support).toContain("wrong_answer");
    expect(support).toContain("tone_wording");
    expect(support).not.toContain("reserve_too_low");
    const claims = quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code);
    expect(claims).toContain("wrong_coverage_decision");
    expect(claims).toContain("tone_wording");
  });
});

describe("draft origin", () => {
  it("uses an explicit origin when the caller supplies one", () => {
    expect(draftOriginFrom({ origin: "ai" })).toBe("ai");
    expect(draftOriginFrom({ origin: "draft:ai" })).toBe("ai");
    expect(draftOriginFrom({ origin: "fin" })).toBe("ai");
    expect(draftOriginFrom({ origin: "manual" })).toBe("manual");
    expect(draftOriginFrom({ origin: "draft:manual" })).toBe("manual");
    expect(draftOriginFrom({ origin: "unknown" })).toBe("unknown");
  });

  it("accepts an explicit assist flag or draft author type, never the text itself", () => {
    expect(draftOriginFrom({ assist: true })).toBe("ai");
    expect(draftOriginFrom({ assist: false })).toBe("unknown");
    expect(draftOriginFrom({ authorType: "bot" })).toBe("ai");
    expect(draftOriginFrom({ authorType: "admin" })).toBe("manual");
    expect(draftOriginFrom({ authorType: "user" })).toBe("unknown");
    // A draft that merely mentions Fin is not evidence that Fin wrote it.
    expect(draftOriginFrom({ origin: "Fin wrote this reply" })).toBe("unknown");
    expect(draftOriginFrom({})).toBe("unknown");
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("a reply-sized insert into an empty composer is the draft; typing is not", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.onComposer("", {}, 0)).toBeNull();
    let text = "";
    for (let i = 1; i <= 100; i++) {
      text += "ab";
      expect(d.onComposer(text, {}, i * 100)).toBeNull();
    }
    expect(d.current()).toBeNull();
    const d2 = createDraftDetector({ minDraftChars: 80 });
    d2.onComposer("", {}, 0);
    expect(d2.onComposer(long, { origin: "ai" }, 500)?.origin).toBe("ai");
    expect(d2.onComposer(`${long} more`, {}, 600)).toBeNull(); // only the first
  });

  it("a composer that already holds a reply on load is a draft, with origin unknown unless told", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    const first = d.onComposer(long, undefined, 10);
    expect(first?.origin).toBe("unknown");
    expect(statusLine(first, null)).toBe("Draft inserted · 1 words");
    const told = createDraftDetector({ minDraftChars: 80 });
    expect(told.onComposer(long, { origin: "manual" }, 10)?.origin).toBe("manual");
  });

  it("a paste after a pause while a short greeting was typed still counts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", {}, 0);
    d.onComposer("Hi Dana,", {}, 1000);
    expect(d.onComposer(`Hi Dana,\n${long}`, { origin: "ai" }, 9000)?.origin).toBe("ai");
  });

  it("marks the current text by hand, and never invents an origin", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    expect(d.mark("short note", {}, 5)?.origin).toBe("unknown");
    expect(d.mark("short note", { origin: "manual" }, 5)?.origin).toBe("manual");
    expect(d.mark("   ", {}, 5)).toBeNull();
  });
});

describe("context and html", () => {
  it("strips html and maps Intercom roles", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(conversation)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Where is my refund? I was charged twice.",
        at: "2025-10-09T08:53:20.000Z",
      },
      {
        role: "agent",
        author: "ray@carrier.com",
        content: "Let me check that for you.\nOne moment.",
        at: "2025-10-09T08:55:00.000Z",
      },
      { role: "note", author: "Ray", content: "Refund approved in Stripe.", at: null },
      { role: "agent", author: "Fin", content: "Fin drafted a reply.", at: null },
    ]);
  });

  it("accepts the bare conversation_parts array too", () => {
    const bare: IntercomConversation = {
      id: "9",
      conversation_parts: [{ part_type: "comment", body: "Only part", author: { type: "user" } }],
    };
    expect(contextFrom(bare)).toEqual([{ role: "customer", author: null, content: "Only part", at: null }]);
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
    // Most cases test the capture shape; require_reason has its own case below.
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft and on an empty send", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "x" } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, send: { text: "<p></p>" } })).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("sending the draft unchanged is an approve capture", () => {
    const d = decideOnSend({ ...base, send: { text: draftText } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("intercom");
    expect(d.body.externalId).toBe("ic:42");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.actor).toBe("ray@carrier.com");
    expect(d.body.subject).toBe("Where is my refund?");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.draft.text).toContain("refund was approved");
    expect(d.body.tags).toEqual(["draft:ai"]);
    expect(d.body.url).toBe("https://app.intercom.com/a/inbox/workspace/conversation/42");
    expect(typeof d.body.secondsToSend).toBe("number");
    expect(d.body.context).toHaveLength(4);
    expect(d.body.metadata).toEqual({ conversationId: "42" });
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Refunds land in 2 days",
      send: { text: sent },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Refunds land in 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason blocks a changed capture until a code is picked; a note alone is not enough", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const sent = draftText.replace("approved", "declined");
    const blocked = decideOnSend({ ...base, settings: DEFAULT_SETTINGS, send: { text: sent } });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });
    const noteOnly = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reason: "the refund was wrong",
      send: { text: sent },
    });
    expect(noteOnly.action).toBe("need-reason");
    const ok = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reasonCode: "wrong_answer",
      send: { text: sent },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("wrong_answer");
    const unchanged = decideOnSend({ ...base, settings: DEFAULT_SETTINGS, send: { text: draftText } });
    expect(unchanged.action).toBe("capture");
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [{ key: "refund", label: "refund" }],
    };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_answer",
      draftFields: { refund: "no" },
      send: { text: draftText, fields: { refund: "yes" } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["refund"]);
    expect(d.body.draft.fields).toEqual({ refund: "no" });
    expect(d.body.sent.fields).toEqual({ refund: "yes" });
  });

  it("records how long the draft sat in front of the teammate", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "ai", at: 10_000 },
      now: 14_250,
      send: { text: draftText },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(4.3);
  });

  it("a recorded draft attaches to its run", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "ai",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1,
      },
      send: { text: draftText },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
  });

  it("tags a draft of unknown origin as unknown rather than guessing", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "unknown", at: 1 },
      send: { text: draftText },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.tags).toEqual(["draft:unknown"]);
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe(
      "Draft inserted · 3 words",
    );
    expect(statusLine(null, { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(null, { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });
});
