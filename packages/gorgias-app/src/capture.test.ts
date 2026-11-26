import { describe, expect, it } from "vitest";
import {
  contextFrom,
  createDraftDetector,
  DEFAULT_SETTINGS,
  decideOnSend,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
  type GorgiasTicketSnapshot,
} from "./capture";

const draftText = "<p>Hi Dana,</p><p>Your replacement order is on the way and should arrive in 2 business days. I can also share tracking now.</p>";
const ticket: GorgiasTicketSnapshot = {
  id: 9912,
  subject: "Order delay",
  customer: { email: "dana@example.com", name: "Dana" },
  messages: [
    { id: 1, body_html: "<div>Where is my order?<br>It was due yesterday.</div>", sender: { email: "dana@example.com" }, from_agent: false, created_datetime: "2026-11-16T10:00:00Z" },
    { id: 2, body_text: "Checked warehouse: label created, pickup pending.", sender: { name: "Ray" }, from_agent: true, internal: true },
  ],
};

describe("settings", () => {
  it("parses manifest params with defaults", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    const s = settingsFrom({ overturn_base_url: "https://ov.internal/", agent: "support-reply", require_reason: "false", min_draft_chars: "120", reason_pack: "claims" });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(false);
    expect(s.minDraftChars).toBe(120);
    expect(s.reasonPack).toBe("claims");
  });
  it("provides support reasons by default", () => {
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
  });
});

describe("draft detection", () => {
  const long = "x".repeat(200);
  it("detects inserted and preloaded drafts", () => {
    const d = createDraftDetector({ minDraftChars: 80 });
    d.onComposer("", 0);
    expect(d.onComposer(long, 500)?.origin).toBe("inserted");
    const d2 = createDraftDetector({ minDraftChars: 80 });
    expect(d2.onComposer(long, 10)?.origin).toBe("preloaded");
  });
});

describe("context", () => {
  it("builds ticket context with roles and stripped html", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
    expect(contextFrom(ticket)).toEqual([
      { role: "customer", author: "dana@example.com", content: "Where is my order?\nIt was due yesterday.", at: "2026-11-16T10:00:00Z" },
      { role: "note", author: "Ray", content: "Checked warehouse: label created, pickup pending.", at: null },
    ]);
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "inserted" as const, at: 1000 };
  const base = { ticket, draft, draftFields: {}, reasonCode: null as string | null, reason: "", actor: "ray@merchant.com", settings: { ...DEFAULT_SETTINGS, requireReason: false } };

  it("skips without draft or empty send", () => {
    expect(decideOnSend({ ...base, draft: null, send: { text: "x" } })).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: { text: "<p></p>" } })).toEqual({ action: "skip", why: "empty" });
  });

  it("captures unchanged send as approve with gorgias external id", () => {
    const d = decideOnSend({ ...base, now: 4200, send: { text: draftText } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:9912");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.secondsToSend).toBe(3.2);
    expect(d.body.context).toHaveLength(2);
  });

  it("captures changed send with reason and tags", () => {
    const d = decideOnSend({ ...base, reasonCode: "wrong_answer", reason: "Corrected ETA", send: { text: draftText.replace("2 business days", "tomorrow") } });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reasonCode).toBe("wrong_answer");
    expect(d.body.reason).toBe("Corrected ETA");
    expect(d.body.tags).toEqual(["draft:inserted"]);
  });

  it("requires reason when changed and requireReason enabled", () => {
    const d = decideOnSend({ ...base, settings: DEFAULT_SETTINGS, send: { text: draftText.replace("2 business days", "tomorrow") } });
    expect(d).toEqual({ action: "need-reason", changedFields: [] });
  });
});

describe("statusLine", () => {
  it("describes states", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "manual", at: 1 }, null)).toBe("Draft marked by you · 3 words");
    expect(statusLine(null, { changed: false, dedup: false })).toBe("Sent as drafted · approved");
  });
});
