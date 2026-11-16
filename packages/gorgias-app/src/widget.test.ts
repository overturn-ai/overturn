import { describe, expect, it } from "vitest";
import { settingsFrom } from "./capture";
import { signLink, verifyLink } from "./sign";
import { buildWidgetTemplate, draftUrl, linkSigner, reasonUrl, widgetData } from "./widget";

const TOKEN = "w_secret_shared";
const settings = settingsFrom({
  app_url: "https://app.overturn.test/",
  widget_token: TOKEN,
  reason_pack: "support",
});

describe("the widget Gorgias renders", () => {
  it("is a ticket sidebar card fed by the integration's response", () => {
    const widget = buildWidgetTemplate(settings);
    expect(widget).toMatchObject({ name: "Overturn", context: "ticket", type: "http", order: 3 });
    const card = widget.template.widgets?.[0];
    expect(card).toMatchObject({ type: "card", path: "", meta: { displayCard: true, link: "{{app_url}}" } });
    expect(card?.widgets?.map((w) => w.path)).toEqual([
      "status",
      "detail",
      "draft_action",
      ...[
        "wrong_answer",
        "missing_information",
        "wrong_amount_or_date",
        "missing_required_step",
        "against_policy",
        "should_escalate",
        "tone_wording",
        "wrong_language_or_format",
      ].map((c) => `reason_${c}`),
    ]);
    // One click per reason and one for the draft page: the rows themselves are the links.
    const links = card?.widgets?.filter((w) => w.meta?.link) ?? [];
    expect(links).toHaveLength(9);
    expect(links.map((w) => w.meta?.link)).toContain("{{draft_url}}");
  });

  it("shows the claims pack when the installer asked for it", () => {
    const claims = buildWidgetTemplate(settingsFrom({ reason_pack: "claims" }));
    const paths = claims.template.widgets?.[0]?.widgets?.map((w) => w.path) ?? [];
    expect(paths).toContain("reason_reserve_too_low");
    expect(paths).not.toContain("reason_wrong_answer");
  });
});

describe("the links the card shows", () => {
  it("carry a signature, not the shared secret", () => {
    const reason = reasonUrl(settings, 48213, "wrong_answer");
    const draft = draftUrl(settings, 48213);
    expect(reason).toContain("ticket_id=48213&code=wrong_answer");
    expect(reason).toContain("&exp=");
    expect(reason).toContain("&sig=");
    // The token goes into the integration URL Gorgias keeps, never into a link or a browser history.
    expect(reason).not.toContain(TOKEN);
    expect(draft).not.toContain(TOKEN);
    expect(new URL(reason).origin).toBe("https://app.overturn.test");
  });

  it("only authorize the exact action, ticket and code they name", () => {
    const signer = linkSigner(TOKEN, () => 1_000_000);
    const path = signer.reason(48213, "wrong_answer");
    const query = new URL(`https://x${path}`).searchParams;
    const exp = query.get("exp");
    const sig = query.get("sig");
    expect(verifyLink(TOKEN, "reason", "48213", exp, sig, { extra: "wrong_answer", now: 1_000_001 })).toBe(
      true,
    );
    expect(verifyLink(TOKEN, "reason", "48213", exp, sig, { extra: "tone_wording", now: 1_000_001 })).toBe(
      false,
    );
    expect(verifyLink(TOKEN, "draft", "48213", exp, sig, { now: 1_000_001 })).toBe(false);
    expect(verifyLink(TOKEN, "reason", "999", exp, sig, { extra: "wrong_answer", now: 1_000_001 })).toBe(
      false,
    );
    expect(verifyLink("other-secret", "reason", "48213", exp, sig, { extra: "wrong_answer" })).toBe(false);
  });

  it("stop working when they expire", () => {
    const signed = signLink(TOKEN, "draft", "48213", { now: 0, ttlMs: 1000 });
    expect(verifyLink(TOKEN, "draft", "48213", String(signed.exp), signed.sig, { now: 999 })).toBe(true);
    expect(verifyLink(TOKEN, "draft", "48213", String(signed.exp), signed.sig, { now: 1001 })).toBe(false);
  });
});

describe("the response the widget reads", () => {
  it("says what is in the reply box and what to do next", () => {
    const data = widgetData({
      settings,
      ticketId: 48213,
      draft: { text: "one two three", origin: "recorded", at: 1, fields: {} },
      lastResult: null,
      detail: "Changed the draft? Pick why below (one click) before you send.",
      reasonCode: "missing_information",
    });
    expect(data.app_url).toBe("https://app.overturn.test");
    expect(data.status).toBe("Draft inserted · 3 words");
    expect(data.detail).toBe("Changed the draft? Pick why below (one click) before you send.");
    expect(data.reason_missing_information).toBe("recorded ✓");
    expect(data.reason_wrong_answer).toBe("record · one click");
    expect(data.reason_wrong_answer_url).toContain("/gorgias/reason?ticket_id=48213&code=wrong_answer");
    expect(data.draft_action).toBe("Replace the draft text");
    expect(data.draft_url).toContain("/gorgias/draft?ticket_id=48213");
  });

  it("offers the draft page as the way in when nothing recorded a draft", () => {
    const data = widgetData({
      settings,
      ticketId: 7,
      draft: null,
      lastResult: null,
      detail: null,
      reasonCode: null,
    });
    expect(data.status).toBe("Waiting for a draft");
    expect(data.draft_action).toBe("No recorded draft? Paste it here");
    expect(data.detail).toBe("");
  });

  it("repeats the last outcome, in the sidebar's words", () => {
    const base = { settings, ticketId: 1, draft: null, detail: null, reasonCode: null };
    expect(widgetData({ ...base, lastResult: { kind: "edit", changed: true } }).status).toBe(
      "Captured · edit saved as a case",
    );
    expect(widgetData({ ...base, lastResult: { kind: "approve", changed: false } }).status).toBe(
      "Sent as drafted · approved",
    );
  });
});
