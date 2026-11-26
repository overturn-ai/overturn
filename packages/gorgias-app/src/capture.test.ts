import { describe, expect, it } from "vitest";
import {
  contextFrom,
  type DraftState,
  decideOnSend,
  isoAt,
  latestAgentSend,
  orderContext,
  quickReasons,
  settingsFrom,
  statusLine,
  type TicketSnapshot,
} from "./capture";

const at = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const DRAFT_TEXT =
  "Hi Ada, I looked into order 8123 and it left our warehouse on Monday. It should arrive Thursday.";

const draft = (over: Partial<DraftState> = {}): DraftState => ({
  text: DRAFT_TEXT,
  origin: "recorded",
  runId: "6f2b2a44-6e0f-4b1f-9b8a-0f1e2d3c4b5a",
  model: null,
  at: at("2026-11-16T09:30:00Z"),
  ...over,
});

const ticket = (over: Partial<TicketSnapshot> = {}): TicketSnapshot => ({
  id: 48213,
  subject: "Where is my order?",
  customerEmail: "ada@example.com",
  customerName: "Ada Lovelace",
  assigneeEmail: "agent@example.com",
  messages: [
    {
      id: 1,
      bodyText: "My order 8123 has not arrived.",
      fromAgent: false,
      authorEmail: "ada@example.com",
      createdAt: "2026-11-16T09:00:00",
    },
    {
      id: 2,
      bodyText: "I looked into order 8123 and it left our warehouse on Monday.",
      fromAgent: true,
      authorEmail: "agent@example.com",
      createdAt: "2026-11-16T10:00:00",
    },
  ],
  tags: ["ecommerce"],
  orders: [
    {
      id: 8123,
      provider: "shopify",
      total: "49.90",
      currency: "USD",
      itemCount: 2,
      createdAt: "2026-11-10T12:00:00",
    },
  ],
  fields: {},
  url: null,
  ...over,
});

describe("settingsFrom", () => {
  it("falls back to the defaults", () => {
    const settings = settingsFrom({});
    expect(settings.baseUrl).toBe("https://api.overturn.run");
    expect(settings.agent).toBe("support-reply");
    expect(settings.requireReason).toBe(true);
    expect(settings.reasonPack).toBe("support");
    expect(settings.decisionFields).toEqual([]);
  });

  it("reads the overrides", () => {
    const settings = settingsFrom({
      overturn_base_url: "https://api.example.com/",
      agent: "returns-reply",
      require_reason: "false",
      capture_internal_notes: "1",
      reason_pack: "claims",
      min_draft_chars: "12",
    });
    expect(settings.baseUrl).toBe("https://api.example.com");
    expect(settings.agent).toBe("returns-reply");
    expect(settings.requireReason).toBe(false);
    expect(settings.captureInternalNotes).toBe(true);
    expect(settings.reasonPack).toBe("claims");
    expect(settings.minDraftChars).toBe(12);
  });

  it("parses the decision fields", () => {
    const settings = settingsFrom({ decision_fields: "custom_field_1:refund, custom_field_2" });
    expect(settings.decisionFields).toEqual([
      { id: "custom_field_1", label: "refund" },
      { id: "custom_field_2", label: "custom_field_2" },
    ]);
  });
});

describe("isoAt", () => {
  it("adds the offset Gorgias leaves out", () => {
    expect(isoAt("2020-02-01T19:12:32.432197")).toBe("2020-02-01T19:12:32.432Z");
  });

  it("keeps an offset that is there", () => {
    expect(isoAt("2020-02-01T19:12:32+02:00")).toBe("2020-02-01T17:12:32.000Z");
  });

  it("returns null for nothing usable", () => {
    expect(isoAt(null)).toBeNull();
    expect(isoAt("")).toBeNull();
    expect(isoAt("not a date")).toBeNull();
  });
});

describe("contextFrom", () => {
  it("keeps the roles and the author of the thread", () => {
    const context = contextFrom(ticket());
    expect(context).toHaveLength(2);
    expect(context[0]?.role).toBe("customer");
    expect(context[1]?.role).toBe("agent");
    expect(context[1]?.author).toBe("agent@example.com");
    expect(context[1]?.at).toBe("2026-11-16T10:00:00.000Z");
  });

  it("leaves out empty messages", () => {
    const context = contextFrom(
      ticket({
        messages: [{ bodyText: "   ", fromAgent: true, createdAt: "2026-11-16T10:00:00" }],
      }),
    );
    expect(context).toEqual([]);
  });
});

describe("orderContext", () => {
  it("is null when the ticket carries no order", () => {
    expect(orderContext(ticket({ orders: [] }))).toBeNull();
  });

  it("takes the newest order", () => {
    const order = orderContext(
      ticket({
        orders: [
          { id: 1, provider: "shopify", total: "10.00", currency: "USD", itemCount: 1 },
          { id: 2, provider: "shopify", total: "20.00", currency: "USD", itemCount: 3 },
        ],
      }),
    );
    expect(order?.id).toBe(2);
    expect(order?.total).toBe("20.00");
    expect(order?.currency).toBe("USD");
    expect(order?.item_count).toBe(3);
  });
});

describe("latestAgentSend", () => {
  it("is null when nobody answered", () => {
    const onlyCustomer = ticket({
      messages: [{ bodyText: "hello", fromAgent: false, createdAt: "2026-11-16T09:00:00" }],
    });
    expect(latestAgentSend(onlyCustomer, draft())).toBeNull();
  });

  it("takes the newest agent reply", () => {
    const send = latestAgentSend(ticket(), draft());
    expect(send?.text).toContain("left our warehouse");
    expect(send?.at).toBe(at("2026-11-16T10:00:00Z"));
  });

  it("ignores a reply that is older than the draft", () => {
    const send = latestAgentSend(ticket(), draft({ at: at("2026-11-16T11:00:00Z") }));
    expect(send).toBeNull();
  });
});

describe("decideOnSend", () => {
  const settings = settingsFrom({});

  it("skips a ticket without a draft", () => {
    const decision = decideOnSend({
      ticket: ticket(),
      draft: null,
      draftFields: {},
      send: { text: "hi", at: at("2026-11-16T10:00:00Z"), isNote: false },
      reasonCode: null,
      reason: "",
      actor: null,
      settings,
    });
    expect(decision.action).toBe("skip");
  });

  it("skips a reply that is only a note", () => {
    const decision = decideOnSend({
      ticket: ticket(),
      draft: draft(),
      draftFields: {},
      send: { text: "internal", at: at("2026-11-16T10:00:00Z"), isNote: true },
      reasonCode: null,
      reason: "",
      actor: null,
      settings,
    });
    expect(decision).toEqual({ action: "skip", why: "note" });
  });

  it("captures the reply the agent sent unchanged", () => {
    const decision = decideOnSend({
      ticket: ticket(),
      draft: draft(),
      draftFields: {},
      send: { text: DRAFT_TEXT, at: at("2026-11-16T10:00:00Z"), isNote: false },
      reasonCode: null,
      reason: "",
      actor: null,
      settings,
    });
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changed).toBe(false);
    expect(decision.body.source).toBe("gorgias");
    expect(decision.body.externalId).toBe("gr:48213");
    expect(decision.body.reasonCode).toBeNull();
    expect(decision.body.tags).toEqual(["draft:recorded", "public-reply"]);
    expect(decision.body.draftRunId).toBe("6f2b2a44-6e0f-4b1f-9b8a-0f1e2d3c4b5a");
    expect(decision.body.context).toHaveLength(2);
    expect(decision.body.metadata?.["order"]).toMatchObject({ id: 8123, provider: "shopify" });
    expect(decision.body.metadata?.["requester"]).toBe("ada@example.com");
  });

  it("holds a changed reply until a reason is picked", () => {
    const decision = decideOnSend({
      ticket: ticket(),
      draft: draft(),
      draftFields: {},
      send: {
        text: "Your order 8123 shipped on Monday and should arrive Thursday.",
        at: at("2026-11-16T10:00:00Z"),
        isNote: false,
      },
      reasonCode: null,
      reason: "",
      actor: null,
      settings,
    });
    expect(decision.action).toBe("need-reason");
    if (decision.action !== "need-reason") return;
    expect(decision.body.reasonCode).toBeNull();
    expect(decision.body.externalId).toBe("gr:48213");
  });

  it("captures the changed reply with the reason", () => {
    const decision = decideOnSend({
      ticket: ticket(),
      draft: draft(),
      draftFields: {},
      send: {
        text: "Your order 8123 shipped on Monday and should arrive Thursday.",
        at: at("2026-11-16T10:00:00Z"),
        isNote: false,
      },
      reasonCode: "wrong_answer",
      reason: "the date was wrong",
      actor: "agent@example.com",
      settings,
    });
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.changed).toBe(true);
    expect(decision.body.reasonCode).toBe("wrong_answer");
    expect(decision.body.reason).toBe("the date was wrong");
    expect(decision.body.actor).toBe("agent@example.com");
  });

  it("counts the seconds the draft sat in front of the agent", () => {
    const decision = decideOnSend({
      ticket: ticket(),
      draft: draft(),
      draftFields: {},
      send: { text: DRAFT_TEXT, at: at("2026-11-16T10:00:00Z"), isNote: false },
      reasonCode: null,
      reason: "",
      actor: null,
      settings,
      now: at("2026-11-16T10:00:00Z"),
    });
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.body.secondsToSend).toBe(1800);
  });

  it("falls back to the assignee when there is no actor", () => {
    const decision = decideOnSend({
      ticket: ticket(),
      draft: draft(),
      draftFields: {},
      send: { text: DRAFT_TEXT, at: at("2026-11-16T10:00:00Z"), isNote: false },
      reasonCode: null,
      reason: "",
      actor: null,
      settings,
    });
    expect(decision.action).toBe("capture");
    if (decision.action !== "capture") return;
    expect(decision.body.actor).toBe("agent@example.com");
  });
});

describe("statusLine", () => {
  it("waits for a draft", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
  });

  it("counts the words of the draft", () => {
    expect(statusLine(draft(), null)).toBe("Draft inserted · 18 words");
  });

  it("says what the last capture did", () => {
    expect(statusLine(draft(), { kind: "approve", changed: false, dedup: false })).toBe(
      "Sent as drafted · approved",
    );
    expect(statusLine(draft(), { kind: "edit", changed: true, dedup: false })).toBe(
      "Captured · edit saved as a case",
    );
    expect(statusLine(draft(), { kind: "edit", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
  });
});

describe("quickReasons", () => {
  it("offers the support pack by default", () => {
    const codes = quickReasons(settingsFrom({})).map((r) => r.code);
    expect(codes).toContain("wrong_answer");
    expect(codes).toContain("against_policy");
    expect(codes).toHaveLength(8);
  });

  it("offers the claims pack when the admin picks it", () => {
    const codes = quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code);
    expect(codes).toContain("wrong_coverage_decision");
  });
});
