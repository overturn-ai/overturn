import { captureCreateSchema } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import type { GorgiasMessage, GorgiasTicket } from "./capture";
import { createHandler, type Fetch, type HandlerEnv, safeEqual, type WidgetData } from "./handler";
import { integrationBody, widgetTemplate } from "./setup";

const env: HandlerEnv = {
  OVERTURN_API_KEY: "ov_test_key",
  WEBHOOK_SECRET: "s3cret",
  GORGIAS_DOMAIN: "acme",
  GORGIAS_USER: "api@acme.com",
  GORGIAS_API_KEY: "gorgias_key",
};

const draftBody =
  "Hi Dana, your order #1042 shipped yesterday with UPS and should arrive within 5 business days. Tracking is below.";
const msgs = (sent: string | null, extra: GorgiasMessage[] = []): GorgiasMessage[] => [
  {
    id: 1,
    public: true,
    from_agent: false,
    sender: { email: "dana@example.com" },
    body_text: "Where is it?",
    created_datetime: "2026-11-10T10:00:00Z",
  },
  {
    id: 2,
    channel: "internal-note",
    public: false,
    from_agent: true,
    body_text: `[AI draft] ${draftBody}`,
    created_datetime: "2026-11-10T10:01:00Z",
  },
  ...(sent === null
    ? []
    : [
        {
          id: 3,
          channel: "email",
          public: true,
          from_agent: true,
          sender: { email: "sam@acme.com" },
          body_text: sent,
          created_datetime: "2026-11-10T10:02:00Z",
        },
      ]),
  ...extra,
];

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake Gorgias REST API and Overturn API behind one fetch. */
function fakeFetch(opts: {
  ticket?: GorgiasTicket;
  gorgiasStatus?: number;
  captureStatus?: number | "network";
  runs?: unknown[];
}) {
  const calls: Call[] = [];
  const impl: Fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith("https://acme.gorgias.com/api/tickets/")) {
      if (opts.gorgiasStatus) return new Response("{}", { status: opts.gorgiasStatus });
      return Response.json(opts.ticket ?? { id: 9001, messages: [] });
    }
    if (url.startsWith("https://api.overturn.run/v1/runs")) return Response.json({ items: opts.runs ?? [] });
    if (url === "https://api.overturn.run/v1/capture") {
      if (opts.captureStatus === "network") throw new TypeError("fetch failed");
      if (opts.captureStatus) return new Response("{}", { status: opts.captureStatus });
      const body = JSON.parse(String(init?.body)) as { draft: { text: string }; sent: { text: string } };
      const changed = body.draft.text !== body.sent.text;
      return Response.json({
        kind: changed ? "edit" : "approve",
        changed,
        deduplicated: false,
        case: changed ? { title: "Shipping time" } : null,
      });
    }
    return new Response("not found", { status: 404 });
  };
  const captures = () => calls.filter((c) => c.url.endsWith("/v1/capture"));
  return { impl, calls, captures };
}

const req = (
  path: string,
  init: { body?: Record<string, string>; secret?: string | null; form?: boolean } = {},
) => {
  const headers: Record<string, string> = {};
  if (init.secret !== null) headers["x-overturn-secret"] = init.secret ?? "s3cret";
  let body: string | undefined;
  if (init.body) {
    headers["content-type"] = init.form ? "application/x-www-form-urlencoded" : "application/json";
    body = init.form ? new URLSearchParams(init.body).toString() : JSON.stringify(init.body);
  }
  return new Request(`https://handler.example${path}`, {
    method: "POST",
    headers,
    ...(body ? { body } : {}),
  });
};
const data = async (r: Response) => ((await r.json()) as WidgetData).overturn;

describe("auth", () => {
  it("rejects a missing or wrong secret", async () => {
    const f = fakeFetch({});
    const h = createHandler(env, f.impl);
    expect((await h(req("/gorgias/event?ticket_id=9001", { secret: null }))).status).toBe(401);
    expect((await h(req("/gorgias/event?ticket_id=9001", { secret: "nope" }))).status).toBe(401);
    expect(f.calls).toHaveLength(0);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("POST /gorgias/event (the HTTP integration)", () => {
  it("reads the ticket with Basic auth and shows the draft while it waits", async () => {
    const f = fakeFetch({ ticket: { id: 9001, messages: msgs(null) } });
    const r = await createHandler(env, f.impl)(req("/gorgias/event?ticket_id=9001"));
    expect(r.status).toBe(200);
    const d = await data(r);
    expect(d.status).toBe(`Draft inserted · ${draftBody.split(/\s+/).length} words`);
    const auth = new Headers(f.calls[0]!.init?.headers).get("authorization");
    expect(auth).toBe(`Basic ${btoa("api@acme.com:gorgias_key")}`);
    expect(f.captures()).toHaveLength(0);
  });

  it("an unchanged send posts an approve capture to /v1/capture with the project key", async () => {
    const f = fakeFetch({ ticket: { id: 9001, subject: "Where?", messages: msgs(draftBody) } });
    const d = await data(await createHandler(env, f.impl)(req("/gorgias/event?ticket_id=9001")));
    expect(d.status).toBe("Sent as drafted · approved");
    expect(f.captures()).toHaveLength(1);
    const call = f.captures()[0]!;
    expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer ov_test_key");
    const body = captureCreateSchema.parse(JSON.parse(String(call.init?.body)));
    expect(body.source).toBe("gorgias");
    expect(body.externalId).toBe("gr:9001");
    expect(body.draft.text).toBe(draftBody);
  });

  it("a changed send without a reason posts nothing yet and asks for one (the reply already went out)", async () => {
    const f = fakeFetch({ ticket: { id: 9001, messages: msgs(draftBody.replace("5", "2")) } });
    const d = await data(await createHandler(env, f.impl)(req("/gorgias/event?ticket_id=9001")));
    expect(d.pending_reason).toBe(true);
    expect(d.status).toBe("Changed · pick why below to save it");
    expect(f.captures()).toHaveLength(0);
  });

  it("a later message on an already-sent exchange does not capture it again", async () => {
    const later: GorgiasMessage = {
      id: 4,
      public: true,
      from_agent: false,
      body_text: "Thanks!",
      created_datetime: "2026-11-10T12:00:00Z",
    };
    const f = fakeFetch({ ticket: { id: 9001, messages: msgs(draftBody, [later]) } });
    await createHandler(env, f.impl)(req("/gorgias/event?ticket_id=9001"));
    expect(f.captures()).toHaveLength(0);
  });

  it("lists messages separately when the ticket comes without them", async () => {
    const calls: string[] = [];
    const impl: Fetch = async (url) => {
      calls.push(url);
      if (url.endsWith("/tickets/9001")) return Response.json({ id: 9001 });
      if (url.endsWith("/tickets/9001/messages")) return Response.json({ data: msgs(null) });
      return Response.json({ items: [] });
    };
    const d = await data(await createHandler(env, impl)(req("/gorgias/event?ticket_id=9001")));
    expect(d.status).toMatch(/^Draft inserted/);
    expect(calls).toContain("https://acme.gorgias.com/api/tickets/9001/messages");
  });

  it("an out-of-scope ticket sends nothing to Overturn", async () => {
    const f = fakeFetch({ ticket: { id: 9001, tags: [{ name: "billing" }], messages: msgs(draftBody) } });
    const d = await data(
      await createHandler({ ...env, SCOPE_TAG: "ai_drafted" }, f.impl)(req("/gorgias/event?ticket_id=9001")),
    );
    expect(d.status).toBe('Not watching: no "ai_drafted" tag');
    expect(f.calls.every((c) => c.url.includes("gorgias.com"))).toBe(true);
  });
});

describe("fail open", () => {
  it("Overturn down: 200 with a status line, never an error Gorgias would retry", async () => {
    for (const captureStatus of [500, "network"] as const) {
      const f = fakeFetch({ ticket: { id: 9001, messages: msgs(draftBody) }, captureStatus });
      const r = await createHandler(env, f.impl)(req("/gorgias/event?ticket_id=9001"));
      expect(r.status).toBe(200);
      expect((await data(r)).status).toBe(
        `Overturn could not save this correction (${captureStatus}). The reply was sent.`,
      );
    }
  });
  it("Gorgias unreadable, the runs lookup failing, or a bad ticket id: still 200", async () => {
    const down = fakeFetch({ gorgiasStatus: 503 });
    const r = await createHandler(env, down.impl)(req("/gorgias/event?ticket_id=9001"));
    expect(r.status).toBe(200);
    expect((await data(r)).status).toContain("(503)");

    const impl: Fetch = async (url) => {
      if (url.includes("/v1/runs")) throw new TypeError("fetch failed");
      if (url.includes("/v1/capture"))
        return Response.json({ kind: "approve", changed: false, deduplicated: false });
      return Response.json({ id: 9001, messages: msgs(draftBody) });
    };
    expect((await data(await createHandler(env, impl)(req("/gorgias/event?ticket_id=9001")))).status).toBe(
      "Sent as drafted · approved",
    );

    const bad = await createHandler(env, down.impl)(req("/gorgias/event?ticket_id=../../x"));
    expect(bad.status).toBe(200);
  });
});

describe("POST /gorgias/reason (the widget buttons)", () => {
  it("posts the held capture with the picked code, the note and the clicking agent", async () => {
    const f = fakeFetch({ ticket: { id: 9001, messages: msgs(draftBody.replace("5", "2")) } });
    const r = await createHandler(
      env,
      f.impl,
    )(
      req("/gorgias/reason", {
        form: true,
        body: {
          ticket_id: "9001",
          reason_code: "wrong_amount_or_date",
          note: "Ground is 2 days",
          actor: "sam@acme.com",
        },
      }),
    );
    const d = await data(r);
    expect(d.status).toBe("Captured · edit saved as a case");
    expect(d.case_title).toBe("Shipping time");
    const body = captureCreateSchema.parse(JSON.parse(String(f.captures()[0]!.init?.body)));
    expect(body.reasonCode).toBe("wrong_amount_or_date");
    expect(body.reason).toBe("Ground is 2 days");
    expect(body.actor).toBe("sam@acme.com");
  });
  it("does nothing for an unchanged reply, a reply not sent yet, or a malformed code", async () => {
    for (const [sent, code] of [
      [draftBody, "wrong_answer"],
      [null, "wrong_answer"],
      [draftBody.replace("5", "2"), "DROP TABLE"],
    ] as const) {
      const f = fakeFetch({ ticket: { id: 9001, messages: msgs(sent) } });
      const r = await createHandler(
        env,
        f.impl,
      )(req("/gorgias/reason", { body: { ticket_id: "9001", reason_code: code } }));
      expect(r.status).toBe(200);
      expect(f.captures()).toHaveLength(0);
    }
  });
});

describe("setup", () => {
  it("the integration fires on new messages and carries the secret", () => {
    const i = integrationBody("https://h.example/", "s3cret");
    expect(i.http.url).toBe("https://h.example/gorgias/event?ticket_id={{ticket.id}}");
    expect(i.http.headers["X-Overturn-Secret"]).toBe("s3cret");
    expect(i.http.triggers["ticket-message-created"]).toBe(true);
  });
  it("the widget has one reason button per code of the pack, each with an optional note", () => {
    const w = widgetTemplate("https://h.example", "s3cret", { reasonPack: "support" });
    const card = w.template.widgets[0]!;
    expect(card.path).toBe("overturn");
    const buttons = card.meta.custom.buttons;
    expect(buttons.map((b) => b.label)).toContain("Wrong answer");
    const form = buttons[0]!.action.body["application/x-www-form-urlencoded"];
    expect(form.find((f) => f.key === "ticket_id")?.value).toBe("{{ticket.id}}");
    expect(form.find((f) => f.key === "note")?.editable).toBe(true);
    expect(buttons[0]!.action.url).toBe("https://h.example/gorgias/reason");
  });
});
