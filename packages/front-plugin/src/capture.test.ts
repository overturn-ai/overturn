import { describe, expect, it, vi } from "vitest";
import {
  buildCapture,
  contextFrom,
  draftStatus,
  postCapture,
  settingsFrom,
  snapshotDraft,
  stripHtml,
} from "./capture";

const settings = { ...settingsFrom({}, "ov_test"), requireReason: false };
const conversation = { id: "cnv_123", subject: "Claim update" };
const draft = { id: "dra_123", content: { body: "<p>We will reply in 5 days.</p>", type: "html" as const } };
const messages = [
  { id: "msg_1", status: "inbound", from: { handle: "customer@example.com" }, content: { body: "Please help." } },
];

describe("Front capture payload", () => {
  it("normalizes HTML and records the Front source and conversation ID", () => {
    const snapshot = snapshotDraft(draft, 1_000);
    expect(snapshot?.text).toBe("We will reply in 5 days.");
    const result = buildCapture({
      conversation, messages, draft: snapshot, sent: "We will reply in 2 days.",
      actor: "agent@example.com", reasonCode: "wrong_amount_or_date", reason: "SLA is 2 days",
      settings, now: 3_000,
    });
    expect(result.action).toBe("capture");
    if (result.action !== "capture") return;
    expect(result.body.source).toBe("front");
    expect(result.body.externalId).toBe("fr:cnv_123");
    expect(result.body.draft).toEqual({ text: "We will reply in 5 days." });
    expect(result.body.sent).toEqual({ text: "We will reply in 2 days." });
    expect(result.body.reasonCode).toBe("wrong_amount_or_date");
    expect(result.body.tags).toEqual(["draft:observed", "front"]);
    expect(result.body.metadata).toMatchObject({ draftOrigin: "unverified" });
    expect(result.body.context).toHaveLength(1);
    expect(result.body.secondsToSend).toBe(2);
  });

  it("requires a reason code for changed replies when configured", () => {
    const result = buildCapture({
      conversation, messages, draft: snapshotDraft(draft, 1), sent: "Changed.",
      actor: null, reasonCode: null, reason: "note only",
      settings: { ...settings, requireReason: true },
    });
    expect(result).toEqual({ action: "need-reason", changedFields: [] });
  });

  it("does not require a reason for an unchanged reply", () => {
    const result = buildCapture({
      conversation, messages, draft: snapshotDraft(draft), sent: draft.content.body,
      actor: null, reasonCode: null, reason: "",
      settings: { ...settings, requireReason: true },
    });
    expect(result.action).toBe("capture");
    if (result.action === "capture") expect(result.body.reasonCode).toBeNull();
  });

  it("builds message context, strips HTML, and excludes the sent reply from prior context", () => {
    const outbound = {
      id: "msg_2",
      status: "outbound",
      from: { handle: "agent@example.com" },
      content: { body: "Final reply" },
    };
    expect(stripHtml("<p>Hello&nbsp;there</p><p>A &amp; B</p>")).toBe("Hello there\nA & B");
    expect(contextFrom([...messages, outbound])[0]?.role).toBe("customer");
    expect(contextFrom([...messages, outbound], "msg_2")).toHaveLength(1);
  });

  it("formats the inserted-draft status", () => {
    expect(draftStatus("one two three")).toBe("Draft detected · 3 words");
  });

  it("never throws capture failures into the host workflow", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 503 }));
    await expect(postCapture("https://example.test", "key", {
      source: "front",
      externalId: "fr:1",
      agent: "test-agent",
      context: [],
      draft: { text: "a" },
      sent: { text: "b" },
    }, fetcher)).rejects.toThrow("503");
  });
});
