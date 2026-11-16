import type { CaptureCreate } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import { type AppSettings, type MessageSnapshot, settingsFrom, type TicketSnapshot } from "./capture";
import { GorgiasError } from "./gorgias";
import { createHandler, createMemoryStore, type Handler } from "./handler";
import { OverturnError } from "./overturn";

const draftText = "Hi Dana, your replacement lid ships today and I refunded the shipping.";
const sentText = `${draftText} Heard back from the warehouse: it ships on Monday.`;

const settings = settingsFrom({
  app_url: "https://app.overturn.test",
  widget_token: "w_secret",
  agent: "support-reply",
});

const customerMessage: MessageSnapshot = {
  id: 1,
  public: true,
  fromAgent: false,
  senderEmail: "dana@example.com",
  createdAt: "2026-10-01T10:00:00Z",
  text: "The lid arrived cracked.",
};

const replyMessage: MessageSnapshot = {
  id: 9,
  public: true,
  fromAgent: true,
  senderEmail: "ray@acme.com",
  createdAt: "2026-10-01T13:00:00Z",
  text: sentText,
};

function ticketWith(messages: MessageSnapshot[], extra: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    id: 48213,
    subject: "Cracked lid in order 4509",
    customerEmail: "dana@example.com",
    customerName: "Dana",
    messages,
    fields: {},
    order: {},
    tags: ["vip"],
    url: "https://acme.gorgias.com/app/tickets/48213",
    ...extra,
  };
}

interface Harness {
  handler: Handler;
  captures: CaptureCreate[];
  lookups: string[];
  setTicket(t: TicketSnapshot | null): void;
}

function harness(opts: {
  ticket?: TicketSnapshot | null;
  run?: { id: string; agent: string; output: unknown; endedAt?: string | null } | null;
  settings?: AppSettings;
  failFirstCapture?: boolean;
}): Harness {
  const captures: CaptureCreate[] = [];
  const lookups: string[] = [];
  let ticket: TicketSnapshot | null = opts.ticket === undefined ? ticketWith([customerMessage]) : opts.ticket;
  let attempts = 0;
  const handler = createHandler({
    settings: opts.settings ?? settings,
    store: createMemoryStore(),
    now: () => Date.parse("2026-10-01T14:00:00Z"),
    gorgias: {
      async ticket() {
        if (!ticket) throw new GorgiasError("Gorgias returned 404 for ticket 48213", 404);
        return ticket;
      },
    },
    overturn: {
      async lastRun(externalId, agent) {
        lookups.push(`${externalId}/${agent}`);
        return opts.run ? { model: null, ...opts.run } : null;
      },
      async capture(body) {
        attempts += 1;
        if (opts.failFirstCapture && attempts === 1) throw new OverturnError("/v1/capture returned 500", 500);
        captures.push(body);
        const changed = body.draft.text !== body.sent.text;
        return {
          kind: changed ? "edit" : "approve",
          changed,
          deduplicated: false,
          case: changed ? { title: "Warehouse ships Mondays" } : null,
        };
      },
    },
  });
  return {
    handler,
    captures,
    lookups,
    setTicket(next) {
      ticket = next;
    },
  };
}

async function widget(h: Harness, query = "ticket_id=48213&token=w_secret") {
  const res = await h.handler(new Request(`https://app.overturn.test/gorgias/widget?${query}`));
  return { res, data: (await res.json()) as Record<string, string> };
}

describe("the widget Gorgias calls on every ticket event", () => {
  it("shows the recorded draft, files the send, and never files it twice", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage]),
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: "w_secret",
        agent: "support-reply",
        require_reason: "false",
      }),
    });

    const first = await widget(h);
    expect(first.res.status).toBe(200);
    expect(first.data.status).toBe("Draft inserted · 12 words");
    expect(first.data.detail).toBe("Changed the draft? Pick why below (one click) before you send.");
    expect(h.captures).toHaveLength(0);

    h.setTicket(ticketWith([customerMessage, replyMessage]));
    const second = await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({
      source: "gorgias",
      externalId: "gr:48213",
      actor: "ray@acme.com",
      draft: { text: draftText },
      sent: { text: sentText },
      reasonCode: null,
      draftRunId: "run-1",
    });
    expect(second.data.status).toBe("Captured · edit saved as a case");
    expect(second.data.detail).toContain("Filed as a case");

    // The same reply is never filed again, however often Gorgias refreshes the widget.
    await widget(h);
    expect(h.captures).toHaveLength(1);
  });

  it("files an approve when the reply went out as drafted", async () => {
    const h = harness({
      ticket: ticketWith([
        customerMessage,
        { ...replyMessage, text: draftText, senderEmail: "dana@example.com" },
      ]),
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
    });
    const { data } = await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]?.sent.text).toBe(draftText);
    expect(data.status).toBe("Sent as drafted · approved");
  });

  it("does not capture a reply that predates the draft", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage, { ...replyMessage, createdAt: "2026-10-01T11:00:00Z" }]),
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
    });
    await widget(h);
    expect(h.captures).toHaveLength(0);
  });

  it("holds a changed reply until the agent picks a reason, then files it", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage, replyMessage]),
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
    });
    const { data } = await widget(h);
    expect(h.captures).toHaveLength(0);
    expect(data.detail).toContain("pick why you changed the reply");
    expect(data.reason_missing_information).toBe("record · one click");

    const res = await h.handler(
      new Request(
        "https://app.overturn.test/gorgias/reason?ticket_id=48213&code=missing_information&token=w_secret",
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Reason recorded");
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({ reasonCode: "missing_information", externalId: "gr:48213" });

    const after = await widget(h);
    expect(after.data.status).toBe("Captured · edit saved as a case");
  });

  it("keeps the optional note from the reason page", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage, replyMessage]),
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
    });
    await widget(h);
    const body = new URLSearchParams({
      ticket_id: "48213",
      code: "wrong_amount_or_date",
      note: "Warehouse ships Mondays",
      token: "w_secret",
    });
    const res = await h.handler(
      new Request("https://app.overturn.test/gorgias/reason", { method: "POST", body: body.toString() }),
    );
    expect(res.status).toBe(200);
    expect(h.captures[0]).toMatchObject({
      reasonCode: "wrong_amount_or_date",
      reason: "Warehouse ships Mondays",
    });
  });

  it("uses a reason picked before the send, so the capture never waits", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage]),
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
    });
    await widget(h);
    await h.handler(
      new Request(
        "https://app.overturn.test/gorgias/reason?ticket_id=48213&code=tone_wording&token=w_secret",
      ),
    );
    const { data } = await widget(h);
    expect(data.reason_tone_wording).toBe("recorded ✓");
    expect(h.captures).toHaveLength(0);

    h.setTicket(ticketWith([customerMessage, replyMessage]));
    const sent = await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]?.reasonCode).toBe("tone_wording");
    expect(sent.data.status).toBe("Captured · edit saved as a case");
  });

  it("files a changed reply with no reason when require_reason is off", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage, replyMessage]),
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
      settings: settingsFrom({ app_url: "https://app.overturn.test", require_reason: "false" }),
    });
    await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]?.reasonCode).toBeNull();
  });

  it("says a failed filing will be retried, and retries it on the next trigger", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage, replyMessage]),
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
      failFirstCapture: true,
    });
    // The reply is held for a reason first, so the failing attempt is the one that follows the click.
    const held = await widget(h);
    expect(held.data.detail).toContain("pick why you changed the reply");

    const clicked = await h.handler(
      new Request(
        "https://app.overturn.test/gorgias/reason?ticket_id=48213&code=wrong_answer&token=w_secret",
      ),
    );
    expect(await clicked.text()).toContain("could not save this correction");
    expect(h.captures).toHaveLength(0);

    const retried = await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(retried.data.status).toBe("Captured · edit saved as a case");
  });

  it("reads nothing at all for a ticket outside the scope tag", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage, replyMessage]),
      settings: settingsFrom({ app_url: "https://app.overturn.test", scope_tag: "ai_drafted" }),
    });
    const { data } = await widget(h);
    expect(data.detail).toBe('Not watching: no "ai_drafted" tag.');
    expect(h.lookups).toHaveLength(0);
    expect(h.captures).toHaveLength(0);
  });

  it("says so when Gorgias will not hand over the ticket", async () => {
    const h = harness({ ticket: null });
    const { res, data } = await widget(h);
    expect(res.status).toBe(200);
    expect(data.status).toBe("Waiting for a draft");
    expect(data.detail).toContain("Could not read this ticket");
  });

  it("takes the draft by hand when nothing recorded it", async () => {
    const h = harness({
      ticket: ticketWith([customerMessage]),
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: "w_secret",
        min_draft_chars: "40",
      }),
    });
    const page = await h.handler(
      new Request("https://app.overturn.test/gorgias/draft?ticket_id=48213&token=w_secret"),
    );
    expect(await page.text()).toContain("Put the draft text in Overturn");

    const short = new URLSearchParams({ ticket_id: "48213", text: "Hi!", token: "w_secret" });
    const rejected = await h.handler(
      new Request("https://app.overturn.test/gorgias/draft", { method: "POST", body: short.toString() }),
    );
    expect(await rejected.text()).toContain("shorter than 40 characters");

    const body = new URLSearchParams({ ticket_id: "48213", text: draftText, token: "w_secret" });
    const saved = await h.handler(
      new Request("https://app.overturn.test/gorgias/draft", { method: "POST", body: body.toString() }),
    );
    expect(await saved.text()).toContain("Draft saved · 12 words");

    const { data } = await widget(h);
    expect(data.status).toBe("Draft marked by you · 12 words");
    expect(h.captures).toHaveLength(0);
  });

  it("skips internal notes, and captures them when the installer asked", async () => {
    const note: MessageSnapshot = { ...replyMessage, id: 10, public: false, text: sentText };
    const withNote = ticketWith([customerMessage, note]);
    const skipped = harness({
      ticket: withNote,
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
    });
    await widget(skipped);
    expect(skipped.captures).toHaveLength(0);

    const asked = harness({
      ticket: withNote,
      run: { id: "run-1", agent: "support-reply", output: draftText, endedAt: "2026-10-01T12:00:00Z" },
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        capture_internal_notes: "true",
        require_reason: "false",
      }),
    });
    await widget(asked);
    expect(asked.captures[0]?.tags).toEqual(["draft:recorded", "internal-note"]);
  });
});

describe("the app's own routes", () => {
  it("answers health and refuses everything else", async () => {
    const h = harness({ ticket: null });
    expect(await (await h.handler(new Request("https://app.overturn.test/health"))).json()).toEqual({
      ok: true,
      agent: "support-reply",
    });
    expect(
      (await h.handler(new Request("https://app.overturn.test/gorgias/nope?token=w_secret"))).status,
    ).toBe(404);
    expect((await h.handler(new Request("https://app.overturn.test/"))).status).toBe(404);
    expect(
      (await h.handler(new Request("https://app.overturn.test/gorgias/widget?token=w_secret"))).status,
    ).toBe(400);
    expect((await h.handler(new Request("https://app.overturn.test/gorgias/nope"))).status).toBe(403);
  });

  it("wants the install's token on every call once one is set", async () => {
    const h = harness({ ticket: ticketWith([customerMessage]) });
    expect(
      (await h.handler(new Request("https://app.overturn.test/gorgias/widget?ticket_id=1"))).status,
    ).toBe(403);
    expect((await widget(h, "ticket_id=48213&token=wrong")).res.status).toBe(403);
    expect((await widget(h)).res.status).toBe(200);
  });

  it("refuses a reason that is not a code", async () => {
    const h = harness({ ticket: ticketWith([customerMessage]) });
    const res = await h.handler(
      new Request("https://app.overturn.test/gorgias/reason?ticket_id=48213&code=NOT A CODE&token=w_secret"),
    );
    expect(res.status).toBe(400);
  });
});
