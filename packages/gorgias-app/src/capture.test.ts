import { describe, expect, it } from "vitest";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
  type TicketSnapshot,
} from "./capture";

const draftText =
  "<p>Hi Dana,</p><p>Thanks for the photos. Storm damage to the roof is covered under your HO-3 policy. An adjuster will contact you within 5 business days.</p>";

const ticket: TicketSnapshot = {
  id: 48213,
  subject: "Roof leak after storm",
  requesterEmail: "dana@example.com",
  requesterName: "Dana",
  comments: [
    {
      id: 1,
      value: "<div>Water came through the ceiling.<br>Photos attached.</div>",
      type: "publicReply",
      authorEmail: "dana@example.com",
      isAgent: false,
      createdAt: "2026-10-01T10:00:00Z",
    },
    { id: 2, value: "HO-3, no prior claims.", type: "internalNote", authorName: "Ray", isAgent: true },
  ],
  fields: {},
  url: "https://acme.gorgias.com/ticket/48213",
};

describe("settings", () => {
  it("parses the manifest parameters", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal",
      agent: "support-reply",
      require_reason: "true",
      capture_internal_notes: "false",
      decision_fields: "custom_field_123:coverage, custom_field_9:reserve",
      min_draft_chars: "60",
      scope_tag: "overturn",
      reason_pack: "claims",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("support-reply");
    expect(s.requireReason).toBe(true);
    expect(s.captureInternalNotes).toBe(false);
    expect(s.decisionFields).toEqual([
      { id: "custom_field_123", label: "coverage" },
      { id: "custom_field_9", label: "reserve" },
    ]);
    expect(s.minDraftChars).toBe(60);
    expect(s.scopeTag).toBe("overturn");
    expect(s.reasonPack).toBe("claims");
  });

  it("falls back to defaults when nothing is provided", () => {
    const s = settingsFrom({});
    expect(s.baseUrl).toBe(DEFAULT_SETTINGS.baseUrl);
    expect(s.agent).toBe(DEFAULT_SETTINGS.agent);
    expect(s.requireReason).toBe(DEFAULT_SETTINGS.requireReason);
    expect(s.captureInternalNotes).toBe(DEFAULT_SETTINGS.captureInternalNotes);
    expect(s.decisionFields).toEqual(DEFAULT_SETTINGS.decisionFields);
    expect(s.minDraftChars).toBe(DEFAULT_SETTINGS.minDraftChars);
    expect(s.scopeTag).toBe(DEFAULT_SETTINGS.scopeTag);
    expect(s.reasonPack).toBe(DEFAULT_SETTINGS.reasonPack);
  });
});

describe("scope", () => {
  it("with no scope tag every ticket is in scope", () => {
    expect(inScope([], { ...DEFAULT_SETTINGS, scopeTag: null })).toBe(true);
  });
  it("with scope tag only matching tickets are in scope", () => {
    expect(inScope(["overturn"], { ...DEFAULT_SETTINGS, scopeTag: "overturn" })).toBe(true);
    expect(inScope(["other"], { ...DEFAULT_SETTINGS, scopeTag: "overturn" })).toBe(false);
  });
});

describe("draft detector", () => {
  it("detects a jump from small to large in one change", () => {
    const det = createDraftDetector({ minDraftChars: 80 });
    det.onComposer("Hi,"); // first sight, too short
    const d = det.onComposer("Hi, here is the full reply that was pasted in by the AI draft and is definitely long enough to count as a draft.");
    expect(d).not.toBeNull();
    expect(d?.origin).toBe("inserted");
    expect(d?.text).toContain("full reply");
  });

  it("detects a large first sight as inserted", () => {
    const det = createDraftDetector({ minDraftChars: 80 });
    const d = det.onComposer("This is the first time we see the composer and it already has a full AI draft pasted in with enough characters to qualify.");
    expect(d).not.toBeNull();
    expect(d?.origin).toBe("inserted");
  });

  it("returns null once a draft is already recorded", () => {
    const det = createDraftDetector({ minDraftChars: 80 });
    det.onComposer("This is a long enough first sight to trigger the draft detection mechanism.");
    const d = det.onComposer("This is a subsequent call after the draft was already recorded.");
    expect(d).toBeNull();
  });
});

describe("stripHtml", () => {
  it("converts common tags to readable text", () => {
    const html = "<p>Hello<br>world</p><div>foo</div><li>bar</li>";
    const text = stripHtml(html);
    expect(text).toContain("Hello");
    expect(text).toContain("world");
    expect(text).toContain("foo");
    expect(text).toContain("bar");
  });

  it("decodes common entities", () => {
    expect(stripHtml("& < > " ' &nbsp;")).toBe("& < > \" '  ");
  });
});

describe("contextFrom", () => {
  it("builds the correct context payload for Gorgias", () => {
    const ctx = contextFrom(ticket);
    expect(ctx.source).toBe("gorgias");
    expect(ctx.externalId).toBe("gr:48213");
    expect(ctx.ticketId).toBe("48213");
    expect(ctx.subject).toBe(ticket.subject);
    expect(ctx.requester).toBe("dana@example.com");
    expect(ctx.requesterEmail).toBe("dana@example.com");
    expect(ctx.requesterName).toBe("Dana");
    expect(ctx.comments).toHaveLength(2);
    expect(ctx.comments[0].type).toBe("publicReply");
    expect(ctx.comments[1].type).toBe("internalNote");
    expect(ctx.url).toBe(ticket.url);
    expect(ctx.fields).toEqual({});
  });
});

describe("decideOnSend", () => {
  it("returns skip when no draft is detected", () => {
    const result = decideOnSend({ ticket, composerText: "Hi," });
    expect(result.action).toBe("skip");
  });

  it("returns capture with body when draft detected and sent unchanged", () => {
    const result = decideOnSend({ ticket, composerText: draftText, settings: DEFAULT_SETTINGS });
    expect(result.action).toBe("capture");
    expect(result.body).toBeDefined();
    expect(result.body?.source).toBe("gorgias");
    expect(result.body?.externalId).toBe("gr:48213");
    expect(result.body?.agent).toBe("support-reply");
    expect(result.body?.context.source).toBe("gorgias");
    expect(result.changed).toBe(false);
  });

  it("returns need-reason when requireReason and draft changed", () => {
    const settings = { ...DEFAULT_SETTINGS, requireReason: true };
    const result = decideOnSend({
      ticket,
      composerText: draftText,
      settings,
    });
    expect(result.action).toBe("need-reason");
    expect(result.changed).toBe(true);
  });
});

describe("quickReasons", () => {
  it("returns the support pack by default", () => {
    expect(quickReasons(DEFAULT_SETTINGS).length).toBeGreaterThan(0);
  });
});

describe("statusLine", () => {
  it("shows waiting when no draft", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
  });
  it("shows approved when sent as drafted", () => {
    expect(statusLine(null, { kind: "capture", changed: false, dedup: false })).toBe("Sent as drafted · approved");
  });
  it("shows captured when changed and not dedup", () => {
    expect(statusLine(null, { kind: "capture", changed: true, dedup: false })).toBe("Captured · edit saved as a case");
  });
  it("shows already in suite when dedup", () => {
    expect(statusLine(null, { kind: "capture", changed: true, dedup: true })).toBe("Captured · already in the suite");
  });
});