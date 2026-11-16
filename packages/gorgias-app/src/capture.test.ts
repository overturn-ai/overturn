import { describe, expect, it, vi } from "vitest";
import {
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  epochAt,
  inScope,
  isoAt,
  latestAgentSend,
  orderContext,
  quickReasons,
  settingsFrom,
  statusLine,
  type TicketSnapshot,
} from "./capture";
import { createGorgiasClient, gorgiasCredentials } from "./gorgias-client";

const draftText =
  "Hi Dana, thanks for reaching out about order #4471. The jacket is out of stock in medium, so I have refunded the $89.00 and you should see it in 5 business days.";

const ticket: TicketSnapshot = {
  id: 48213,
  subject: "Where is my refund?",
  customerEmail: "dana@example.com",
  customerName: "Dana",
  assigneeEmail: "ray@shop.com",
  messages: [
    {
      id: 1,
      bodyText: "I returned the jacket last week. Where is my refund?",
      fromAgent: false,
      authorEmail: "dana@example.com",
      createdAt: "2026-10-01T10:00:00.000000",
    },
    {
      id: 2,
      bodyText: "Order #4471, medium jacket, paid $89.00.",
      fromAgent: true,
      isNote: true,
      authorName: "Ray",
      createdAt: "2026-10-01T10:05:00.000000",
    },
  ],
  tags: ["refund"],
  orders: [
    {
      id: 4471,
      provider: "shopify",
      total: "89.00",
      currency: "USD",
      itemCount: 1,
      createdAt: "2026-09-20T00:00:00.000000Z",
    },
  ],
  fields: {},
  url: "https://acme.gorgias.com/app/tickets/48213",
};

describe("settings", () => {
  it("parses the widget parameters", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "support-reply",
      require_reason: "true",
      decision_fields: "custom_field_1:status, custom_field_2:reserve,custom_field_3",
      min_draft_chars: "120",
      scope_tag: "ai_drafted",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.requireReason).toBe(true);
    expect(s.decisionFields).toEqual([
      { id: "custom_field_1", label: "status" },
      { id: "custom_field_2", label: "reserve" },
      { id: "custom_field_3", label: "custom_field_3" },
    ]);
    expect(s.minDraftChars).toBe(120);
    expect(s.scopeTag).toBe("ai_drafted");
  });

  it("a scope tag limits which tickets are watched at all", () => {
    expect(inScope(["billing"], DEFAULT_SETTINGS)).toBe(true);
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(inScope(["billing"], scoped)).toBe(false);
    expect(inScope(["billing", "ai_drafted"], scoped)).toBe(true);
  });

  it("reason_pack picks the chips: support by default, claims when a claims team opts in", () => {
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

describe("timestamps", () => {
  it("Gorgias writes UTC without an offset; the capture contract wants one", () => {
    expect(isoAt("2026-10-01T10:00:00.000000")).toBe("2026-10-01T10:00:00.000Z");
    expect(isoAt("2026-10-01T10:00:00Z")).toBe("2026-10-01T10:00:00.000Z");
    expect(isoAt("2026-10-01T10:00:00+02:00")).toBe("2026-10-01T08:00:00.000Z");
    expect(isoAt("not a date")).toBeNull();
    expect(isoAt(null)).toBeNull();
    expect(isoAt("")).toBeNull();
  });

  it("epoch seconds from the same string", () => {
    expect(epochAt("2026-10-01T10:00:00.000000")).toBe(Date.parse("2026-10-01T10:00:00Z") / 1000);
    expect(epochAt("nope")).toBeNull();
  });
});

describe("context and order", () => {
  it("maps roles oldest first and puts the offset back", () => {
    expect(contextFrom(ticket)).toEqual([
      {
        role: "customer",
        author: "dana@example.com",
        content: "I returned the jacket last week. Where is my refund?",
        at: "2026-10-01T10:00:00.000Z",
      },
      {
        role: "note",
        author: "Ray",
        content: "Order #4471, medium jacket, paid $89.00.",
        at: "2026-10-01T10:05:00.000Z",
      },
    ]);
  });

  it("the newest order rides along in metadata", () => {
    expect(orderContext(ticket)).toEqual({
      id: 4471,
      provider: "shopify",
      total: "89.00",
      currency: "USD",
      item_count: 1,
      created_at: "2026-09-20T00:00:00.000Z",
    });
    expect(orderContext({ ...ticket, orders: [] })).toBeNull();
  });
});

describe("latestAgentSend", () => {
  it("picks the newest agent message newer than the draft", () => {
    const withReply: TicketSnapshot = {
      ...ticket,
      messages: [
        ...ticket.messages,
        {
          id: 3,
          bodyText: "Refunded $89.00, 5 business days.",
          fromAgent: true,
          createdAt: "2026-10-01T11:00:00.000000",
        },
      ],
    };
    const draft = {
      text: draftText,
      origin: "recorded" as const,
      at: Math.floor(Date.parse("2026-10-01T10:30:00Z") / 1000),
    };
    const send = latestAgentSend(withReply, draft, Math.floor(Date.parse("2026-10-01T12:00:00Z") / 1000));
    expect(send?.text).toBe("Refunded $89.00, 5 business days.");
    expect(send?.isNote).toBe(false);
  });

  it("ignores agent messages older than the draft", () => {
    const draft = {
      text: draftText,
      origin: "recorded" as const,
      at: Math.floor(Date.parse("2026-10-01T12:00:00Z") / 1000),
    };
    expect(latestAgentSend(ticket, draft)).toBeNull();
  });
});

describe("decideOnSend", () => {
  const draft = { text: draftText, origin: "recorded" as const, at: 1 };
  const send = { text: draftText, at: 10, isNote: false };
  const base = {
    ticket,
    draft,
    draftFields: {},
    send,
    reasonCode: null as string | null,
    reason: "",
    actor: "ray@shop.com",
    // The pack requires a reason by default; most cases test the capture shape, so relax it.
    settings: { ...DEFAULT_SETTINGS, requireReason: false },
  };

  it("skips without a draft, without a send, on notes, and on empty sends", () => {
    expect(decideOnSend({ ...base, draft: null })).toEqual({ action: "skip", why: "no-draft" });
    expect(decideOnSend({ ...base, send: null })).toEqual({ action: "skip", why: "no-send" });
    expect(decideOnSend({ ...base, send: { text: "", at: 10, isNote: false } })).toEqual({
      action: "skip",
      why: "empty",
    });
    expect(decideOnSend({ ...base, send: { text: draftText, at: 10, isNote: true } })).toEqual({
      action: "skip",
      why: "note",
    });
  });

  it("sending the draft unchanged is an approve capture", () => {
    const d = decideOnSend(base);
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:48213");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.draft.text).toBe(d.body.sent.text);
    expect(d.body.tags).toEqual(["draft:recorded", "public-reply"]);
    expect(d.body.metadata?.order).toEqual(orderContext(ticket));
    expect(d.body.context).toHaveLength(2);
  });

  it("a changed reply is an edit capture carrying the reason", () => {
    const sent = draftText.replace("5 business days", "2 business days");
    const d = decideOnSend({
      ...base,
      reasonCode: "wrong_amount_or_date",
      reason: "Refund SLA is 2 days",
      send: { text: sent, at: 10, isNote: false },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.body.reason).toBe("Refund SLA is 2 days");
    expect(d.body.reasonCode).toBe("wrong_amount_or_date");
    expect(d.body.sent.text).toContain("2 business days");
  });

  it("require_reason (the default) blocks a changed capture until a reason code is picked; a note alone is not enough", () => {
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    const sent = draftText.replace("refunded", "not refunded");
    const blocked = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      send: { text: sent, at: 10, isNote: false },
    });
    expect(blocked.action).toBe("need-reason");
    if (blocked.action === "need-reason") expect(blocked.body.reasonCode).toBeNull();
    const noteOnly = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reason: "policy",
      send: { text: sent, at: 10, isNote: false },
    });
    expect(noteOnly.action).toBe("need-reason");
    const ok = decideOnSend({
      ...base,
      settings: DEFAULT_SETTINGS,
      reasonCode: "against_policy",
      send: { text: sent, at: 10, isNote: false },
    });
    expect(ok.action).toBe("capture");
    if (ok.action === "capture") expect(ok.body.reasonCode).toBe("against_policy");
    // unchanged is always fine, reason or not
    expect(decideOnSend({ ...base, settings: DEFAULT_SETTINGS }).action).toBe("capture");
  });

  it("decision fields ride along and a changed field is a change", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      decisionFields: [{ id: "custom_field_1", label: "refund_state" }],
    };
    const d = decideOnSend({
      ...base,
      settings,
      reasonCode: "wrong_answer",
      draftFields: { refund_state: "pending" },
      sendFields: { refund_state: "refunded" },
    });
    expect(d.action).toBe("capture");
    if (d.action !== "capture") return;
    expect(d.changed).toBe(true);
    expect(d.changedFields).toEqual(["refund_state"]);
    expect(d.body.draft.fields).toEqual({ refund_state: "pending" });
    expect(d.body.sent.fields).toEqual({ refund_state: "refunded" });
  });

  it("records how long the draft sat in front of the agent", () => {
    const d = decideOnSend({
      ...base,
      draft: { text: draftText, origin: "recorded", at: 1_700_000_000 },
      now: 1_700_000_012,
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.secondsToSend).toBe(12);
  });

  it("a recorded draft attaches to its run", () => {
    const d = decideOnSend({
      ...base,
      draft: {
        text: draftText,
        origin: "recorded",
        runId: "0199a0d0-0000-7000-8000-000000000000",
        model: "gpt-4.1-mini",
        at: 1,
      },
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine(null, null)).toBe("Waiting for a draft");
    expect(statusLine({ text: "one two three", origin: "recorded", at: 1 }, null)).toBe(
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

describe("gorgias client", () => {
  const rawTicket = {
    id: 48213,
    subject: "Where is my refund?",
    customer: { email: "dana@example.com", name: "Dana" },
    assignee_user: { email: "ray@shop.com" },
    tags: [{ name: "refund" }, "vip"],
    // Gorgias returns newest first
    messages: [
      {
        id: 2,
        body_text: "Order #4471, medium jacket.",
        channel: "internal-note",
        from_agent: true,
        sender: { name: "Ray" },
        created_datetime: "2026-10-01T10:05:00.000000",
      },
      {
        id: 1,
        body_text: "Where is my refund?",
        from_agent: false,
        sender: { email: "dana@example.com" },
        created_datetime: "2026-10-01T10:00:00.000000",
      },
    ],
    customer_integrations: [
      {
        provider: "shopify",
        orders: [
          {
            id: 4471,
            total_price: "89.00",
            currency: "USD",
            items: [{}],
            created_datetime: "2026-09-20T00:00:00.000000",
          },
        ],
      },
    ],
  };

  it("reads a ticket, reverses to oldest first, and normalizes it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(rawTicket), { status: 200 }));
    const client = createGorgiasClient({
      baseUrl: "https://acme.gorgias.com/",
      username: "ray@shop.com",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snap = await client.getTicket(48213);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://acme.gorgias.com/api/tickets/48213",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: expect.stringMatching(/^Basic /) }),
      }),
    );
    expect(snap.messages.map((m) => m.id)).toEqual([1, 2]);
    expect(snap.messages[0]).toMatchObject({ fromAgent: false, bodyText: "Where is my refund?" });
    expect(snap.messages[1]).toMatchObject({ fromAgent: true, isNote: true });
    expect(snap.tags).toEqual(["refund", "vip"]);
    expect(snap.orders).toHaveLength(1);
    expect(snap.orders[0]).toMatchObject({ id: 4471, provider: "shopify", itemCount: 1 });
  });

  it("throws with the status on an error response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = createGorgiasClient({
      baseUrl: "https://acme.gorgias.com",
      username: "u",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.getTicket(1)).rejects.toMatchObject({ status: 401 });
  });

  it("reads the credentials out of the settings bag", () => {
    expect(gorgiasCredentials({ gorgias_username: "ray@shop.com", gorgias_api_key: "k" })).toEqual({
      username: "ray@shop.com",
      apiKey: "k",
    });
    expect(gorgiasCredentials({ gorgias_username: "ray@shop.com" })).toBeNull();
    expect(gorgiasCredentials({})).toBeNull();
  });
});
