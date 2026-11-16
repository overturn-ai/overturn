import { describe, expect, it } from "vitest";
import { settingsFrom } from "./capture";
import { buildWidgetTemplate, draftUrl, reasonUrl, widgetData } from "./widget";

const settings = settingsFrom({
  app_url: "https://app.overturn.test/",
  widget_token: "w_secret",
  reason_pack: "support",
});

describe("the widget Gorgias renders", () => {
  it("is a ticket sidebar card fed by the integration's response", () => {
    const widget = buildWidgetTemplate(settings);
    expect(widget).toMatchObject({
      name: "Overturn",
      context: "ticket",
      type: "http",
      order: 3,
    });
    const card = widget.template.widgets?.[0];
    expect(card).toMatchObject({ type: "card", path: "", meta: { displayCard: true, link: "{{app_url}}" } });
    expect(card?.widgets?.map((w) => w.path)).toEqual([
      "status",
      "detail",
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
    // One click per reason: the reason rows themselves are the links.
    const reasons = card?.widgets?.filter((w) => w.path?.startsWith("reason_")) ?? [];
    expect(reasons).toHaveLength(8);
    expect(reasons.every((w) => w.meta?.link === `{{${w.path}_url}}`)).toBe(true);
    expect(card?.widgets?.[0]).toEqual({ type: "text", title: "Status", path: "status" });
  });

  it("shows the claims pack when the installer asked for it", () => {
    const claims = buildWidgetTemplate(settingsFrom({ reason_pack: "claims" }));
    const paths = claims.template.widgets?.[0]?.widgets?.map((w) => w.path) ?? [];
    expect(paths).toContain("reason_reserve_too_low");
    expect(paths).not.toContain("reason_wrong_answer");
  });
});

describe("the response the widget reads", () => {
  it("says what is in the reply box and what to do next", () => {
    const data = widgetData({
      settings,
      ticketId: 48213,
      draft: { text: "one two three", origin: "recorded", at: 1 },
      lastResult: null,
      detail: "Changed the draft? Pick why below (one click) before you send.",
      reasonCode: "missing_information",
    });
    expect(data.app_url).toBe("https://app.overturn.test");
    expect(data.status).toBe("Draft inserted · 3 words");
    expect(data.detail).toBe("Changed the draft? Pick why below (one click) before you send.");
    expect(data.reason_missing_information).toBe("recorded ✓");
    expect(data.reason_wrong_answer).toBe("record · one click");
    expect(data.reason_wrong_answer_url).toBe(
      "https://app.overturn.test/gorgias/reason?ticket_id=48213&code=wrong_answer&token=w_secret",
    );
  });

  it("waits when there is nothing yet, and repeats the last outcome when there is", () => {
    const base = { settings, ticketId: 1, detail: null, reasonCode: null };
    expect(widgetData({ ...base, draft: null, lastResult: null }).status).toBe("Waiting for a draft");
    expect(widgetData({ ...base, draft: null, lastResult: { kind: "edit", changed: true } }).status).toBe(
      "Captured · edit saved as a case",
    );
    expect(widgetData({ ...base, draft: null, lastResult: { kind: "approve", changed: false } }).detail).toBe(
      "",
    );
  });

  it("leaves the token out of the links when the install has none", () => {
    const open = settingsFrom({ app_url: "https://app.overturn.test" });
    expect(reasonUrl(open, 7, "wrong_answer")).toBe(
      "https://app.overturn.test/gorgias/reason?ticket_id=7&code=wrong_answer",
    );
    expect(draftUrl(open, "a b")).toBe("https://app.overturn.test/gorgias/draft?ticket_id=a%20b");
    expect(draftUrl(settings, 7)).toContain("token=w_secret");
  });
});
