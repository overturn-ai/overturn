import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  draftTag,
  findSentMessage,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
  type TicketSnapshot,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Your order #1042 is on its way. The replacement will arrive within 5 business days, and the refund for the damaged item is already processing.</p>";

const ticket: TicketSnapshot = {
  id: 90210,
  subject: "Damaged item in order #1042",
  customerEmail: "dana@example.com",
  customerName: "Dana",
  messages: [
    {
      id: 1,
      bodyText: "The mug arrived cracked. Photo attached.",
      bodyHtml: "<p>The mug arrived cracked. Photo attached.</p>",
      channel: "email",
      authorEmail: "dana@example.com",
      fromAgent: false,
      createdAt: "2026-10-01T10:00:00Z",
    },
    {
      id: 2,
      bodyText: "Order #1042, Shopify, one prior return.",
      bodyHtml: null,
      channel: "internal-note",
      authorName: "Ray",
      fromAgent: true,
    },
  ],
  fields: {},
  url: null,
};

describe("settings", () => {
  it("parses the app configuration", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "support-reply",
      require_reason: "true",
      decision_fields: "order_status:order_status, refund_amount:refund,resolution",
      min_draft_chars: "120",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "order_status", label: "order_status" },
      { id: "refund_amount", label: "refund" },
      { id: "resolution", label: "resolution" },
    ]);
    expect(s.minDraftChars).toBe(120);
  });

  it("a scope tag limits which tickets are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(scoped.scopeTag).toBe("ai_drafted");
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the options: support by default here, claims when a claims team opts in", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain(
      "wrong_coverage_decision",
    );
    const codes = quickReasons(settingsFrom({})).map((r) => r.code);
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

describe("draft origin", () => {
  it("tags only the origins we were told: ai and recorded as draft:ai, manual as draft:manual, unknown as nothing", () => {
    expect(draftTag("ai")).toBe("draft:ai");
    expect(draftTag("recorded")).toBe("draft:ai");
    expect(draftTag("manual")).toBe("draft:manual");
    expect(draftTag("unknown")).toBeNull();
  });

  it("the sent message is the newest agent reply; internal notes and customer messages are not sends", () => {
    expect(findSentMessage(ticket)).toBeNull();
    const sent: TicketSnapshot = {
      ...ticket,
      messages: [
        ...ticket.messages,
        {
          id: 3,
          bodyText: null,
          bodyHtml: "<p>Replacement on its way.</p>",
          channel: "email",
          authorEmail: "ray@shop.com",
          fromAgent: true,
        },
      ],
    };
    expect(findSentMessage(sent)).toEqual({
      text: "Replacement on its way.",
      messageId: 3,
      authorEmail: "ray@shop.com",
    });
  });
});

describe("context and html", () => {
  it("prefers the text body, strips html otherwise, and maps roles", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(ticket)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "The mug arrived cracked. Photo attached.",
        at: "2026-10-01T10:00:00Z",
      },
      { role: "note", author: "Ray", content: "Order #1042, Shopify, one prior return.", at: null },
    ]);
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "ai" as const, at: 1 };
  const base = {
    ticket,
    draft,
    draftFields: {},
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@shop.com",
    // The support pack requires a reason by default; most cases here test the capture shape, so relax it.
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft, on internal notes, and on empty sends", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "x", type: "reply", fields: {} } })).toEqual({
      action: "skip",
      why: "no-draft",
    });
    expect(decideOnSend({ ...base, send: { text: "x", type: "internal-note", fields: {} } })).toEqual({
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
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:90210");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:ai", "public-reply"]);
    expect(typeof d.body.secondsToSend).toBe("number");
    expect(d.body.context).toHaveLength(2);
    expect(d.body.metadata).toEqual({ customer: "dana@example.com" });
    // The enum extension in this PR is what makes this parse: "gorgias" is a capture source.
    expect(captureCreateSchema.parse(d.body).source).toBe("gorgias");
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
      reason: "Express replacement is 2 days",
      send: { text: sent, type: "reply", fields: {} },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Express replacement is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
    expect(d.body.sent.fields).toBeUndefined();
  });

  it("require_reason (the default) holds a changed capture until a reason code is picked; a note alone is not enough", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const settings = DEFAULT_SETTINGS;
    const sent = draftText.replace("already processing", "not possible");
    const blocked = decideOnSend({ ...base, settings, send: { text: sent, type: "reply", fields: {} } });
    expect(blocked).toEqual({ action: "need-reason", changedFields: [] });
    const noteOnly = decideOnSend({
      ...base,
      settings,
      reason: "policy",
      send: { text: sent, type: "reply", fields: {} },
    });
    expect(noteOnly.action).toBe("need-reason");
    const ok = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_answer",
      send: { text: sent, type: "reply", fields: {} },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("wrong_answer");
    const unchanged = decideOnSend({
      ...base,
      settings,
      send: { text: draftText, type: "reply", fields: {} },
    });
    expect(unchanged.action).toBe("capture");
  });

  it("order-context fields ride along and a changed field is a change", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [{ id: "refund_amount", label: "refund" }],
    };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_amount_or_date",
      draftFields: { refund: 24 },
      send: { text: draftText, type: "reply", fields: { refund: 0 } },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["refund"]);
    expect(d.body.draft.fields).toEqual({ refund: 24 });
    expect(d.body.sent.fields).toEqual({ refund: 0 });
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
