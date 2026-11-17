import { describe, expect, it } from "vitest";
import {
  createApp,
  type GorgiasTicket,
  type HttpRequest,
  memoryStore,
  type Overturn,
  reasonSig,
  type WidgetData,
} from "./app";
import { DEFAULT_SETTINGS } from "./capture";

const TOKEN = "tok";
const draft =
  "Hi Dana, order #1042 shipped yesterday with UPS and should arrive within 3 business days. Tracking below.";

function fakes(
  opts: { runs?: Array<{ id: string; output: unknown; startedAt?: string }>; fail?: boolean } = {},
) {
  const posts: Array<Record<string, unknown>> = [];
  let reads = 0;
  const overturn: Overturn = {
    get: async <T>() => ({ items: opts.runs ?? [] }) as T,
    post: async <T>(_p: string, body: unknown) => {
      if (opts.fail) throw Object.assign(new Error("down"), { status: 503 });
      posts.push(body as Record<string, unknown>);
      return { changed: true, deduplicated: false, case: { title: "t" } } as T;
    },
  };
  const ticket: GorgiasTicket = {
    id: 9001,
    subject: "Where is my order?",
    customer: {
      email: "dana@example.com",
      integrations: {
        "1": {
          orders: [
            {
              id: 502,
              name: "#1042",
              financial_status: "paid",
              total_price: "54.90",
              created_at: "2026-10-28T09:00:00Z",
            },
          ],
        },
      },
    },
    messages: [
      {
        id: 1,
        channel: "email",
        from_agent: false,
        public: true,
        body_text: "Nothing yet.",
        created_datetime: "2026-11-01T10:00:00Z",
      },
    ],
    tags: [],
  };
  const fetchTicket = async () => {
    reads++;
    return ticket;
  };
  return { posts, ticket, overturn, fetchTicket, reads: () => reads };
}

const req = (path: string, body: unknown, extra: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "POST",
  path,
  query: {},
  headers: { "x-overturn-token": TOKEN },
  body: JSON.stringify(body),
  ...extra,
});

const NOW = Date.parse("2026-11-01T11:00:00Z");
const reply = (text: string) => ({
  id: 2,
  channel: "email",
  from_agent: true,
  public: true,
  body_text: text,
  sender: { email: "ray@shop.com" },
  created_datetime: "2026-11-01T11:00:05Z",
});

function app(f: ReturnType<typeof fakes>, requireReason = true) {
  return createApp({
    settings: { ...DEFAULT_SETTINGS, requireReason },
    store: memoryStore(),
    overturn: f.overturn,
    fetchTicket: f.fetchTicket,
    token: TOKEN,
    publicUrl: "https://ov-gorgias.example.com/",
    gorgiasUrl: "https://shop.gorgias.com",
    now: () => NOW,
  });
}

const widget = (r: { body: unknown }) => (r.body as WidgetData).overturn;

describe("auth", () => {
  it("rejects a request without the integration token", async () => {
    const f = fakes();
    expect((await app(f)(req("/events", { ticket_id: 9001 }, { headers: {} }))).status).toBe(401);
  });
  it("rejects a forged reason link", async () => {
    const f = fakes();
    const r = await app(f)({
      method: "GET",
      path: "/reason",
      query: { ticket: "9001", code: "wrong_answer", sig: "x" },
      headers: {},
      body: "",
    });
    expect(r.status).toBe(403);
  });
});

describe("events", () => {
  it("a ticket with no draft is never read", async () => {
    const f = fakes();
    const r = await app(f)(req("/events", { ticket_id: 9001 }));
    expect(widget(r).status).toBe("Waiting for a draft");
    expect(widget(r).reasons).toEqual([]);
    expect(f.reads()).toBe(0);
  });

  it("a posted draft, sent unchanged, is an approve capture with the order context", async () => {
    const f = fakes();
    const a = app(f);
    const d = await a(req("/draft", { ticket_id: 9001, text: draft, model: "gpt-4.1-mini" }));
    expect(widget(d).status).toMatch(/^Draft inserted · \d+ words$/);
    expect(widget(d).reasons[0]?.url).toMatch(
      /^https:\/\/ov-gorgias\.example\.com\/reason\?ticket=9001&code=/,
    );
    f.ticket.messages!.push(reply(draft));
    await a(req("/events", { ticket_id: 9001 }));
    expect(f.posts).toHaveLength(1);
    const body = f.posts[0]!;
    expect(body.source).toBe("gorgias");
    expect(body.externalId).toBe("gr:9001");
    expect(body.tags).toEqual(["draft:inserted", "public-reply"]);
    expect(body.draftModel).toBe("gpt-4.1-mini");
    expect(body.url).toBe("https://shop.gorgias.com/app/ticket/9001");
    expect((body.context as Array<{ role: string }>)[0]?.role).toBe("system");
    // A later event does not capture the same reply again.
    await a(req("/events", { ticket_id: 9001 }));
    expect(f.posts).toHaveLength(1);
  });

  it("a changed reply is held until a reason link is clicked", async () => {
    const f = fakes();
    const a = app(f);
    await a(req("/draft", { ticket_id: 9001, text: draft }));
    f.ticket.messages!.push(reply(draft.replace("shipped yesterday", "ships Friday")));
    const held = await a(req("/events", { ticket_id: 9001 }));
    expect(widget(held).status).toBe("Pick why you changed the reply");
    expect(f.posts).toHaveLength(0);
    const sig = reasonSig(TOKEN, "9001", "wrong_answer");
    const page = await a({
      method: "GET",
      path: "/reason",
      query: { ticket: "9001", code: "wrong_answer", sig },
      headers: {},
      body: "",
    });
    expect(page.status).toBe(200);
    expect(f.posts[0]?.reasonCode).toBe("wrong_answer");
  });

  it("an overturn:<code> tag (e.g. from a macro) releases a held capture", async () => {
    const f = fakes();
    const a = app(f);
    await a(req("/draft", { ticket_id: 9001, text: draft }));
    f.ticket.messages!.push(reply(draft.replace("3 business days", "7 business days")));
    await a(req("/events", { ticket_id: 9001 }));
    f.ticket.tags = [{ name: "overturn:wrong_amount_or_date" }];
    await a(req("/events", { ticket_id: 9001 }));
    expect(f.posts[0]?.reasonCode).toBe("wrong_amount_or_date");
  });

  it("a recorded run is the draft (draft:recorded)", async () => {
    const f = fakes({
      runs: [
        { id: "0199a0d0-0000-7000-8000-000000000000", output: draft, startedAt: "2026-11-01T10:30:00Z" },
      ],
    });
    const a = app(f, false);
    f.ticket.messages!.push(reply(draft));
    await a(req("/events", { ticket_id: 9001 }));
    expect(f.posts[0]?.draftRunId).toBe("0199a0d0-0000-7000-8000-000000000000");
    expect(f.posts[0]?.tags).toEqual(["draft:recorded", "public-reply"]);
  });

  it("a failed capture is acknowledged and shown in the widget", async () => {
    const f = fakes({ fail: true });
    const a = app(f, false);
    await a(req("/draft", { ticket_id: 9001, text: draft }));
    f.ticket.messages!.push(reply(draft));
    const r = await a(req("/events", { ticket_id: 9001 }));
    expect(r.status).toBe(200);
    expect(widget(r).message).toContain("could not save");
  });

  it("refuses a greeting as a draft", async () => {
    const f = fakes();
    expect((await app(f)(req("/draft", { ticket_id: 9001, text: "Hi Dana," }))).status).toBe(422);
  });
});
