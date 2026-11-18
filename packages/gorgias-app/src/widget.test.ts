import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DraftState, TicketSnapshot } from "./capture";
import { settingsFrom } from "./capture";
import { orderLine, widgetData, widgetRows, widgetTemplate } from "./widget";

const ticket: TicketSnapshot = {
  id: 48213,
  subject: "Where is my order?",
  customerEmail: "ada@example.com",
  customerName: "Ada Lovelace",
  assigneeEmail: "agent@example.com",
  messages: [],
  tags: [],
  orders: [{ id: 8123, provider: "shopify", total: "49.90", currency: "USD", itemCount: 2 }],
  fields: {},
  url: null,
};

const testDraft = {
  text: "one two three",
  origin: "recorded",
  runId: "6f2b2a44-6e0f-4b1f-9b8a-0f1e2d3c4b5a",
  model: null,
  at: 1_763_287_800,
} satisfies DraftState;

const options = (over: Partial<Parameters<typeof widgetData>[0]> = {}) => ({
  ticket,
  draft: testDraft,
  lastResult: null,
  settings: settingsFrom({}),
  appBaseUrl: "https://app.example.com",
  pendingReason: false,
  note: null,
  ...over,
});

describe("widgetTemplate", () => {
  it("is a wrapper with one card", () => {
    const template = widgetTemplate();
    expect(template.type).toBe("wrapper");
    const card = template.widgets?.[0];
    expect(card?.type).toBe("card");
    expect(card?.title).toBe("Overturn");
  });

  it("reads the status, the order and the note", () => {
    const paths = (widgetTemplate().widgets?.[0]?.widgets ?? [])
      .filter((node) => node.type === "text")
      .map((node) => node.path);
    expect(paths).toContain("status");
    expect(paths).toContain("order");
    expect(paths).toContain("note");
  });

  it("lists the reasons and the note link", () => {
    const lists = (widgetTemplate().widgets?.[0]?.widgets ?? []).filter((node) => node.type === "list");
    expect(lists.map((node) => node.path)).toEqual(["reasons", "notes"]);
    expect(lists[0]?.widgets?.[0]?.meta?.["link"]).toBe("{{link}}");
  });

  it("matches the template that ships in the package", () => {
    const shipped = readFileSync(path.join(import.meta.dirname, "..", "app", "widget.json"), "utf8");
    expect(JSON.parse(shipped)).toEqual(JSON.parse(JSON.stringify(widgetTemplate())));
  });
});

describe("widgetData", () => {
  it("answers with the card the sidebar shows", () => {
    const data = widgetData(options());
    expect(data.status).toBe("Draft inserted · 3 words");
    expect(data.ticket_id).toBe("48213");
    expect(data.order).toBe("Order #8123 49.90 USD");
    expect(data.note).toBeNull();
  });

  it("offers no reason while there is nothing to capture", () => {
    const data = widgetData(options());
    expect(data.reasons).toEqual([]);
    expect(data.notes).toEqual([]);
  });

  it("offers the reasons once a capture waits for one", () => {
    const data = widgetData(options({ pendingReason: true }));
    expect(data.reasons).toHaveLength(8);
    expect(data.reasons[0]?.link).toContain("ticket_id=48213");
    expect(data.reasons[0]?.link).toContain("code=wrong_answer");
    expect(data.notes[0]?.link).toContain("/gorgias/reason");
  });
});

describe("widgetRows", () => {
  it("gives every reason its own code", () => {
    const { reasons } = widgetRows(options({ pendingReason: true }));
    const codes = reasons.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("orderLine", () => {
  it("is null when there is no order", () => {
    expect(orderLine({ ...ticket, orders: [] })).toBeNull();
  });

  it("reads the order id and the amount", () => {
    expect(orderLine(ticket)).toBe("Order #8123 49.90 USD");
  });
});
