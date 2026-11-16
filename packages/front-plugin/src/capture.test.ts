import { describe, expect, it } from "vitest";
import {
  buildCapturePayload,
  contextFrom,
  createDraftDetector,
  type FrontMessage,
  plainText,
  quickReasons,
  settingsFrom,
} from "./capture";

const draftText = "The adjuster will contact you within five business days about the roof claim.";
const conversation = { id: "cnv_123", subject: "Roof claim" };
const thread: FrontMessage[] = [
  {
    id: "msg_1",
    status: "inbound",
    from: { handle: "dana@example.com" },
    date: "2026-11-16T10:00:00Z",
    content: { body: "<p>Water came through the roof.</p>", type: "html" },
  },
];
const settings = settingsFrom({});
const base = {
  conversation,
  context: thread,
  draft: { id: "dra_1", text: draftText, origin: "inserted" as const, at: 10_000 },
  sent: {
    id: "msg_2",
    status: "outbound",
    content: { body: draftText, type: "text" as const },
  },
  actor: "ray@example.com",
  reasonCode: null,
  reason: "",
  settings,
  now: 14_250,
};

describe("Front payload builder", () => {
  it("records an unchanged send with source, thread, ids, and time", () => {
    const decision = buildCapturePayload(base);
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changed).toBe(false);
    expect(decision.body).toMatchObject({
      source: "front",
      externalId: "fr:cnv_123",
      agent: "support-reply",
      actor: "ray@example.com",
      subject: "Roof claim",
      draft: { text: draftText },
      sent: { text: draftText },
      reason: null,
      reasonCode: null,
      secondsToSend: 4.3,
      url: "https://app.frontapp.com/open/cnv_123",
      metadata: { frontDraftId: "dra_1", frontMessageId: "msg_2" },
    });
    expect(decision.body.context).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "Water came through the roof.",
        at: "2026-11-16T10:00:00.000Z",
      },
    ]);
  });

  it("requires a code for a changed send and carries the optional one-line note", () => {
    const sent = {
      ...base.sent,
      content: {
        body: "The adjuster will contact you within two business days about the roof claim.",
        type: "text" as const,
      },
    };
    expect(buildCapturePayload({ ...base, sent })).toEqual({ action: "need-reason" });
    const decision = buildCapturePayload({
      ...base,
      sent,
      reasonCode: "wrong_amount_or_date",
      reason: "  Storm claims have a two-day SLA.  ",
    });
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changed).toBe(true);
    expect(decision.body.reasonCode).toBe("wrong_amount_or_date");
    expect(decision.body.reason).toBe("Storm claims have a two-day SLA.");
    expect(decision.body.sent.text).toContain("two business days");
    expect(decision.body.context).toHaveLength(1);
  });

  it("skips missing drafts, inbound messages, and empty sends", () => {
    expect(buildCapturePayload({ ...base, draft: null })).toEqual({ action: "skip", why: "no-draft" });
    expect(buildCapturePayload({ ...base, sent: { ...base.sent, status: "inbound" } })).toEqual({
      action: "skip",
      why: "not-outbound",
    });
    expect(
      buildCapturePayload({ ...base, sent: { ...base.sent, content: { body: " ", type: "text" } } }),
    ).toEqual({
      action: "skip",
      why: "empty",
    });
  });

  it("allows a changed send without a code only when requireReason is disabled", () => {
    const decision = buildCapturePayload({
      ...base,
      settings: settingsFrom({ requireReason: false }),
      sent: { ...base.sent, content: { body: "A different answer", type: "text" } },
    });
    expect(decision.action).toBe("capture");
  });
});

describe("draft and context", () => {
  it("detects a large insertion, not incremental typing", () => {
    const detector = createDraftDetector(20);
    detector.onComposer("dra_1", "", 0);
    for (let i = 1; i <= 20; i++) expect(detector.onComposer("dra_1", "x".repeat(i), i * 100)).toBeNull();
    expect(detector.onComposer("dra_1", "x".repeat(80), 4000)?.origin).toBe("inserted");
  });

  it("detects a draft already in the composer", () => {
    expect(createDraftDetector(20).onComposer("dra_1", draftText, 1)?.origin).toBe("preloaded");
  });

  it("normalizes HTML and excludes messages with no loaded content", () => {
    expect(plainText("<p>A&nbsp;B</p><p>C<br>D</p>", "html")).toBe("A B\nC\nD");
    expect(contextFrom([...thread, { id: "msg_2", status: "outbound" }])).toHaveLength(1);
  });

  it("uses the shared claims and support reason packs", () => {
    expect(quickReasons(settings).map((r) => r.code)).toContain("wrong_answer");
    expect(quickReasons(settingsFrom({ reasonPack: "claims" })).map((r) => r.code)).toContain(
      "wrong_coverage_decision",
    );
  });
});
