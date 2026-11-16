import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import {
  contextFrom,
  DEFAULT_SETTINGS,
  decideOnSend,
  draftFromRun,
  draftTextOf,
  type GorgiasMessage,
  type GorgiasTicket,
  inScope,
  latestExchange,
  orderFields,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

const draftBody =
  "Hi Dana, thanks for reaching out. Your order #1042 shipped yesterday with UPS and should arrive within 5 business days. Here is your tracking link.";

const customer: GorgiasMessage = {
  id: 1,
  channel: "email",
  public: true,
  from_agent: false,
  sender: { email: "dana@example.com", name: "Dana" },
  body_html: "<div>Where is my order?<br>It was due Monday.</div>",
  body_text: "",
  created_datetime: "2026-11-10T10:00:00Z",
};
const draftNote: GorgiasMessage = {
  id: 2,
  channel: "internal-note",
  public: false,
  from_agent: true,
  sender: { email: "ai@acme.com", name: "AI Drafts" },
  body_text: `[AI draft] ${draftBody}`,
  created_datetime: "2026-11-10T10:01:00Z",
};
const reply = (text: string, extra: Partial<GorgiasMessage> = {}): GorgiasMessage => ({
  id: 3,
  channel: "email",
  public: true,
  from_agent: true,
  sender: { email: "sam@acme.com", name: "Sam" },
  body_text: text,
  created_datetime: "2026-11-10T10:01:42.500Z",
  ...extra,
});

const ticket = (messages: GorgiasMessage[], extra: Partial<GorgiasTicket> = {}): GorgiasTicket => ({
  id: 9001,
  subject: "Where is my order?",
  customer: {
    email: "dana@example.com",
    name: "Dana",
    integrations: {
      "12": {
        __integration_type__: "shopify",
        orders: [
          {
            id: 55,
            name: "#1042",
            financial_status: "paid",
            fulfillment_status: "fulfilled",
            total_price: "59.00",
            currency: "USD",
            created_at: "2026-11-01T09:00:00Z",
          },
          { id: 40, name: "#1001", financial_status: "refunded", created_at: "2026-09-01T09:00:00Z" },
        ],
      },
    },
  },
  tags: [{ name: "shipping" }],
  messages,
  ...extra,
});

const settings = { ...DEFAULT_SETTINGS, gorgiasDomain: "acme" };

describe("settings", () => {
  it("parses the handler settings", () => {
    const s = settingsFrom({
      overturn_base_url: "https://ov.internal/",
      agent: "ecom-reply",
      require_reason: "false",
      min_draft_chars: "40",
      draft_authors: "AI@acme.com, bot@acme.com",
      draft_marker: "AI:",
      gorgias_domain: "acme",
    });
    expect(s.baseUrl).toBe("https://ov.internal");
    expect(s.agent).toBe("ecom-reply");
    expect(s.requireReason).toBe(false);
    expect(s.minDraftChars).toBe(40);
    expect(s.draftAuthors).toEqual(["ai@acme.com", "bot@acme.com"]);
    expect(s.draftMarker).toBe("AI:");
  });
  it("defaults: support pack, require_reason on", () => {
    expect(settingsFrom({})).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.requireReason).toBe(true);
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).toContain("wrong_answer");
    expect(quickReasons(DEFAULT_SETTINGS).map((r) => r.code)).not.toContain("reserve_too_low");
    expect(quickReasons(settingsFrom({ reason_pack: "claims" })).map((r) => r.code)).toContain(
      "wrong_coverage_decision",
    );
  });
  it("a scope tag limits which tickets are captured", () => {
    const scoped = settingsFrom({ scope_tag: "ai_drafted" });
    expect(inScope(ticket([]), DEFAULT_SETTINGS)).toBe(true);
    expect(inScope(ticket([]), scoped)).toBe(false);
    expect(inScope(ticket([], { tags: [{ name: "ai_drafted" }] }), scoped)).toBe(true);
  });
});

describe("draft detection", () => {
  it("an internal note with the marker, or from a drafting user, is the draft", () => {
    expect(draftTextOf(draftNote, settings)).toBe(draftBody);
    const byAuthor = { ...draftNote, body_text: draftBody };
    expect(draftTextOf(byAuthor, settings)).toBeNull();
    expect(draftTextOf(byAuthor, { ...settings, draftAuthors: ["ai@acme.com"] })).toBe(draftBody);
  });
  it("public messages and short notes are never drafts", () => {
    expect(draftTextOf({ ...draftNote, channel: "email", public: true }, settings)).toBeNull();
    expect(draftTextOf({ ...draftNote, body_text: "[AI draft] Hi!" }, settings)).toBeNull();
  });
  it("pairs the latest draft with the first public agent reply after it", () => {
    const ex = latestExchange(ticket([customer, draftNote, reply(draftBody)]), settings);
    expect(ex.draft?.text).toBe(draftBody);
    expect(ex.draft?.origin).toBe("inserted");
    expect(ex.sent?.id).toBe(3);
    expect(ex.sentIsLatest).toBe(true);
    const waiting = latestExchange(ticket([customer, draftNote]), settings);
    expect(waiting.draft).not.toBeNull();
    expect(waiting.sent).toBeNull();
    const later = latestExchange(
      ticket([
        customer,
        draftNote,
        reply(draftBody),
        { ...customer, id: 4, created_datetime: "2026-11-10T11:00:00Z" },
      ]),
      settings,
    );
    expect(later.sentIsLatest).toBe(false);
  });
  it("a recorded SDK run is the draft for the reply sent after it; capture-synthesized runs are not", () => {
    const run = {
      id: "0199a0d0-0000-7000-8000-000000000000",
      output: draftBody,
      startedAt: "2026-11-10T10:00:30Z",
      tags: [],
      metadata: { model: "gpt-4.1-mini" },
    };
    const recorded = draftFromRun(run);
    expect(recorded?.origin).toBe("recorded");
    expect(draftFromRun({ ...run, tags: ["capture:gorgias"] })).toBeNull();
    expect(draftFromRun({ ...run, output: { reply: "x" } })).toBeNull();
    const ex = latestExchange(ticket([customer, reply(draftBody)]), settings, recorded);
    expect(ex.draft?.runId).toBe(run.id);
    expect(ex.sent?.id).toBe(3);
    // a reply from before the run started is not its send
    const old = latestExchange(
      ticket([customer, reply(draftBody, { created_datetime: "2026-11-10T10:00:10Z" })]),
      settings,
      recorded,
    );
    expect(old.sent).toBeNull();
  });
});

describe("context and order", () => {
  it("strips html", () => {
    expect(stripHtml("<p>a&nbsp;b</p><p>c<br>d</p>")).toBe("a b\nc\nd");
  });
  it("the newest order becomes flat fields", () => {
    expect(orderFields(null)).toEqual({});
    const t = ticket([]);
    const order = Object.values(t.customer!.integrations!)[0]!.orders![0]!;
    expect(orderFields(order)).toEqual({
      order: "#1042",
      payment_status: "paid",
      fulfillment_status: "fulfilled",
      total: "59.00 USD",
      ordered_at: "2026-11-01T09:00:00Z",
    });
  });
  it("context is the order line plus the thread before the send, without the draft note", () => {
    const t = ticket([customer, draftNote, reply(draftBody)]);
    const ctx = contextFrom(t, latestExchange(t, settings));
    expect(ctx).toEqual([
      {
        role: "system",
        author: null,
        content:
          "Order: order #1042 · payment status paid · fulfillment status fulfilled · total 59.00 USD · ordered at 2026-11-01T09:00:00Z",
        at: null,
      },
      {
        role: "customer",
        author: "dana@example.com",
        content: "Where is my order?\nIt was due Monday.",
        at: "2026-11-10T10:00:00Z",
      },
    ]);
  });
});

describe("decideOnSend (the payload builder)", () => {
  const decide = (messages: GorgiasMessage[], over: Partial<Parameters<typeof decideOnSend>[0]> = {}) => {
    const t = ticket(messages);
    return decideOnSend({
      ticket: t,
      exchange: latestExchange(t, settings),
      reasonCode: null,
      reason: "",
      settings,
      ...over,
    });
  };

  it("skips without a draft and before the send", () => {
    expect(decide([customer, reply("Hello")])).toEqual({ action: "skip", why: "no-draft" });
    expect(decide([customer, draftNote])).toEqual({ action: "skip", why: "not-sent" });
  });

  it("sent as drafted is an approve capture with source gorgias and externalId gr:<id>", () => {
    const d = decide([customer, draftNote, reply(draftBody)]);
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(false);
    expect(d.body.source).toBe("gorgias");
    expect(d.body.externalId).toBe("gr:9001");
    expect(d.body.agent).toBe("support-reply");
    expect(d.body.actor).toBe("sam@acme.com");
    expect(d.body.subject).toBe("Where is my order?");
    expect(d.body.draft).toEqual({ text: draftBody });
    expect(d.body.sent).toEqual({ text: draftBody });
    expect(d.body.reasonCode).toBeNull();
    expect(d.body.secondsToSend).toBe(42.5);
    expect(d.body.url).toBe("https://acme.gorgias.com/app/ticket/9001");
    expect(d.body.tags).toEqual(["draft:inserted", "channel:email"]);
    expect(d.body.metadata).toMatchObject({ gorgiasMessageId: "3", order: { order: "#1042" } });
    // the body is valid against the API's own contract
    expect(captureCreateSchema.parse(d.body)).toMatchObject({ source: "gorgias", externalId: "gr:9001" });
  });

  it("require_reason (the default) holds a changed reply's capture until a code is picked; a note alone is not enough", () => {
    const sent = draftBody.replace("5 business days", "2 business days");
    expect(decide([customer, draftNote, reply(sent)])).toEqual({ action: "need-reason", changedFields: [] });
    expect(decide([customer, draftNote, reply(sent)], { reason: "UPS 2-day" }).action).toBe("need-reason");
    const ok = decide([customer, draftNote, reply(sent)], {
      reasonCode: "wrong_amount_or_date",
      reason: "UPS Ground is 2 days here",
    });
    if (ok.action !== "capture") throw new Error(ok.action);
    expect(ok.changed).toBe(true);
    expect(ok.body.reasonCode).toBe("wrong_amount_or_date");
    expect(ok.body.reason).toBe("UPS Ground is 2 days here");
    expect(ok.body.sent.text).toContain("2 business days");
    expect(captureCreateSchema.safeParse(ok.body).success).toBe(true);
  });

  it("with require_reason off, a changed reply is captured right away without a code", () => {
    const sent = draftBody.replace("5 business days", "2 business days");
    const d = decide([customer, draftNote, reply(sent)], { settings: { ...settings, requireReason: false } });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.changed).toBe(true);
    expect(d.body.reasonCode).toBeNull();
  });

  it("a recorded draft attaches to its run and model", () => {
    const t = ticket([customer, reply(draftBody)]);
    const recorded = draftFromRun({
      id: "0199a0d0-0000-7000-8000-000000000000",
      output: draftBody,
      startedAt: "2026-11-10T10:01:00Z",
      metadata: { model: "gpt-4.1-mini" },
    });
    const d = decideOnSend({
      ticket: t,
      exchange: latestExchange(t, settings, recorded),
      reasonCode: null,
      reason: "",
      settings,
    });
    if (d.action !== "capture") throw new Error(d.action);
    expect(d.body.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(d.body.draftModel).toBe("gpt-4.1-mini");
    expect(d.body.tags).toContain("draft:recorded");
  });

  it("out-of-scope tickets are skipped", () => {
    expect(
      decide([customer, draftNote, reply(draftBody)], { settings: { ...settings, scopeTag: "ai" } }),
    ).toEqual({
      action: "skip",
      why: "out-of-scope",
    });
  });
});

describe("statusLine", () => {
  it("describes the state", () => {
    expect(statusLine({ kind: "waiting" })).toBe("Waiting for a draft");
    expect(
      statusLine({ kind: "draft", draft: { text: "one two three", origin: "inserted", at: null } }),
    ).toBe("Draft inserted · 3 words");
    expect(statusLine({ kind: "captured", changed: false, dedup: false })).toBe("Sent as drafted · approved");
    expect(statusLine({ kind: "captured", changed: true, dedup: true })).toBe(
      "Captured · already in the suite",
    );
    expect(statusLine({ kind: "error", status: 503 })).toContain("(503)");
  });
});
