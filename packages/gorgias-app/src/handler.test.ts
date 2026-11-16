import type { CaptureCreate } from "@overturn-ai/shared";
import { describe, expect, it } from "vitest";
import { type AppSettings, type MessageSnapshot, settingsFrom, type TicketSnapshot } from "./capture";
import { GorgiasError } from "./gorgias";
import { createHandler, createMemoryStore, type Handler } from "./handler";
import { OverturnError } from "./overturn";
import { linkSigner } from "./widget";

const draftText = "Hi Dana, your replacement lid ships today and I refunded the shipping.";
const sentText = `${draftText} Heard back from the warehouse: it ships on Monday.`;
const TOKEN = "w_secret";

const settings = settingsFrom({
  app_url: "https://app.overturn.test",
  widget_token: TOKEN,
  agent: "support-reply",
});

const signer = linkSigner(TOKEN);

const customerMessage: MessageSnapshot = {
  id: 1,
  public: true,
  fromAgent: false,
  senderEmail: "dana@example.com",
  createdAt: "2026-10-01T10:00:00Z",
  text: "The lid arrived cracked.",
};

/** A reply Gorgias reports as sent at 13:00. */
const sentReply: MessageSnapshot = {
  id: 9,
  public: true,
  fromAgent: true,
  senderEmail: "ray@acme.com",
  createdAt: "2026-10-01T13:00:00Z",
  sentAt: "2026-10-01T13:00:00Z",
  text: sentText,
};

function ticket(extra: Partial<TicketSnapshot> = {}): TicketSnapshot {
  return {
    id: 48213,
    subject: "Cracked lid in order 4509",
    customerEmail: "dana@example.com",
    customerName: "Dana",
    messages: [customerMessage],
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
  ticketsRead(): number;
  messagesRead(): number;
  setTemplate(t: TicketSnapshot): void;
  setMessages(m: MessageSnapshot[]): void;
  setRun(
    run: {
      id: string;
      agent: string;
      output: unknown;
      endedAt?: string | null;
      source?: string | null;
      tags?: string[];
    } | null,
  ): void;
}

function harness(opts: {
  template?: TicketSnapshot;
  messages?: MessageSnapshot[];
  run?: {
    id: string;
    agent: string;
    output: unknown;
    endedAt?: string | null;
    source?: string | null;
    tags?: string[];
  } | null;
  settings?: AppSettings;
  failFirstCapture?: boolean;
  store?: ReturnType<typeof createMemoryStore>;
  now?: number;
}): Harness {
  const captures: CaptureCreate[] = [];
  const lookups: string[] = [];
  let template = opts.template ?? ticket();
  let messages = opts.messages ?? [customerMessage];
  let run = opts.run === undefined ? null : opts.run;
  let attempts = 0;
  let tickets = 0;
  let messageLists = 0;
  const handler = createHandler({
    settings: opts.settings ?? settings,
    store: opts.store ?? createMemoryStore(),
    now: () => opts.now ?? Date.parse("2026-10-01T14:00:00Z"),
    gorgias: {
      async ticket() {
        tickets += 1;
        return template;
      },
      async messages() {
        messageLists += 1;
        return messages;
      },
    },
    overturn: {
      async lastRun(externalId, agent) {
        lookups.push(`${externalId}/${agent}`);
        return run;
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
    ticketsRead: () => tickets,
    messagesRead: () => messageLists,
    setTemplate(t) {
      template = t;
    },
    setMessages(m) {
      messages = m;
    },
    setRun(r) {
      run = r;
    },
  };
}

const recordedDraft = {
  id: "run-1",
  agent: "support-reply",
  output: draftText,
  endedAt: "2026-10-01T12:00:00Z",
};

async function widget(h: Harness, query = `ticket_id=48213&token=${TOKEN}`) {
  const res = await h.handler(new Request(`https://app.overturn.test/gorgias/widget?${query}`));
  return { res, data: (await res.json()) as Record<string, string> };
}

function post(path: string, fields: Record<string, string>) {
  return new Request(`https://app.overturn.test${path}`, {
    method: "POST",
    body: new URLSearchParams(fields).toString(),
  });
}

describe("the widget Gorgias calls", () => {
  it("shows the recorded draft, files the sent reply, and never files it twice", async () => {
    const h = harness({
      run: recordedDraft,
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        require_reason: "false",
      }),
    });

    const first = await widget(h);
    expect(first.res.status).toBe(200);
    expect(first.data.status).toBe("Draft inserted · 12 words");
    expect(h.captures).toHaveLength(0);

    h.setMessages([customerMessage, sentReply]);
    const second = await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({
      source: "gorgias",
      externalId: "gr:48213",
      actor: "ray@acme.com",
      draft: { text: draftText },
      sent: { text: sentText },
      draftRunId: "run-1",
    });
    expect(second.data.status).toBe("Captured · edit saved as a case");

    await widget(h);
    expect(h.captures).toHaveLength(1);
  });

  it("waits for a reply Gorgias has not sent yet, and ignores one that failed to send", async () => {
    const h = harness({
      run: recordedDraft,
      messages: [customerMessage],
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        require_reason: "false",
      }),
    });
    // Gorgias created the outbound message but has not sent it: the customer has not seen it.
    h.setMessages([customerMessage, { ...sentReply, sentAt: null, createdAt: "2026-10-01T13:00:00Z" }]);
    await widget(h);
    expect(h.captures).toHaveLength(0);

    // The send then failed: still not a reply.
    h.setMessages([customerMessage, { ...sentReply, failedAt: "2026-10-01T13:00:05Z" }]);
    await widget(h);
    expect(h.captures).toHaveLength(0);

    // The retry goes out: now it counts, once.
    h.setMessages([customerMessage, { ...sentReply, failedAt: null }]);
    await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]?.sent.text).toBe(sentText);
  });

  it("keeps the decision fields frozen while the draft sits in the reply box", async () => {
    const withFields = settingsFrom({
      app_url: "https://app.overturn.test",
      widget_token: TOKEN,
      decision_fields: "status:refund_amount",
      require_reason: "false",
    });
    const h = harness({
      run: recordedDraft,
      settings: withFields,
      template: ticket({ fields: { refund_amount: 0 } }),
      messages: [customerMessage],
    });
    await widget(h);

    // The agent edits the refund while the AI's text is still in the reply box.
    h.setTemplate(ticket({ fields: { refund_amount: 100 } }));
    await widget(h);

    h.setTemplate(ticket({ fields: { refund_amount: 100 } }));
    h.setMessages([customerMessage, sentReply]);
    await widget(h);

    expect(h.captures).toHaveLength(1);
    // The 0 -> 100 change is the correction; a re-read baseline would have hidden it.
    expect(h.captures[0]?.draft.fields).toEqual({ refund_amount: 0 });
    expect(h.captures[0]?.sent.fields).toEqual({ refund_amount: 100 });
  });

  it("never revives a stale run as the next draft", async () => {
    const h = harness({
      run: recordedDraft,
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        require_reason: "false",
      }),
    });
    await widget(h);
    h.setMessages([customerMessage, sentReply]);
    await widget(h);
    expect(h.captures).toHaveLength(1);

    // The next ticket event still returns that same old run: it must not become a draft again.
    const after = await widget(h);
    expect(after.data.status).toBe("Captured · edit saved as a case");
    expect(h.captures).toHaveLength(1);
  });

  it("ignores a run capture synthesized for an earlier correction", async () => {
    const h = harness({
      run: { ...recordedDraft, source: "capture", tags: ["capture:gorgias"] },
      settings: settingsFrom({ app_url: "https://app.overturn.test", widget_token: TOKEN }),
    });
    const { data } = await widget(h);
    expect(data.status).toBe("Waiting for a draft");
    expect(h.captures).toHaveLength(0);
  });

  it("holds a changed reply until the reason is posted, then files it", async () => {
    const h = harness({ run: recordedDraft, messages: [customerMessage, sentReply] });
    const held = await widget(h);
    expect(h.captures).toHaveLength(0);
    expect(held.data.detail).toContain("pick why you changed the reply");

    // The GET is a confirmation page and changes nothing.
    const path = signer.reason(48213, "missing_information");
    const shown = await h.handler(new Request(`https://app.overturn.test${path}`));
    expect(shown.status).toBe(200);
    expect(await shown.text()).toContain("Record this reason?");
    expect(h.captures).toHaveLength(0);

    const done = await h.handler(post(path, { note: "Ships Monday, not today" }));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("Reason recorded");
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]).toMatchObject({
      reasonCode: "missing_information",
      reason: "Ships Monday, not today",
      externalId: "gr:48213",
    });

    const after = await widget(h);
    expect(after.data.status).toBe("Captured · edit saved as a case");
    expect(h.captures).toHaveLength(1);
  });

  it("uses a reason recorded before the send, so the capture never waits", async () => {
    const h = harness({ run: recordedDraft, messages: [customerMessage] });
    await widget(h);
    const path = signer.reason(48213, "tone_wording");
    await h.handler(post(path, {}));

    const noted = await widget(h);
    expect(noted.data.reason_tone_wording).toBe("recorded ✓");

    h.setMessages([customerMessage, sentReply]);
    await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]?.reasonCode).toBe("tone_wording");
  });

  it("files a changed reply with no reason when require_reason is off", async () => {
    const h = harness({
      run: recordedDraft,
      messages: [customerMessage, sentReply],
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        require_reason: "false",
      }),
    });
    await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]?.reasonCode).toBeNull();
  });

  it("says a failed filing will be retried, and retries it on the next trigger", async () => {
    const h = harness({
      run: recordedDraft,
      messages: [customerMessage, sentReply],
      failFirstCapture: true,
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        require_reason: "false",
      }),
    });
    const failed = await widget(h);
    expect(failed.data.detail).toContain("could not save this correction");
    expect(h.captures).toHaveLength(0);

    const retried = await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(retried.data.status).toBe("Captured · edit saved as a case");
  });

  it("reads nothing beyond the run lookup for a ticket with no draft", async () => {
    const h = harness({ run: null, messages: [customerMessage, sentReply] });
    const { data } = await widget(h);
    expect(data.status).toBe("Waiting for a draft");
    expect(h.lookups).toHaveLength(1);
    // No draft means no reply to diff, so the ticket's messages are never fetched.
    expect(h.ticketsRead()).toBe(0);
    expect(h.messagesRead()).toBe(0);
  });

  it("reads nothing at all for a ticket outside the scope tag", async () => {
    const h = harness({
      template: ticket({ tags: ["vip"] }),
      run: recordedDraft,
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        scope_tag: "ai_drafted",
      }),
    });
    const { data } = await widget(h);
    expect(data.detail).toBe('Not watching: no "ai_drafted" tag.');
    expect(h.captures).toHaveLength(0);
  });

  it("says so when Gorgias will not hand over the ticket", async () => {
    const failing = createHandler({
      settings,
      gorgias: {
        async ticket() {
          throw new GorgiasError("Gorgias returned 404 for ticket 48213", 404);
        },
        async messages() {
          throw new GorgiasError("Gorgias returned 404 for ticket 48213", 404);
        },
      },
      overturn: {
        async lastRun() {
          return recordedDraft;
        },
        async capture() {
          throw new Error("should not be called");
        },
      },
    });
    const res = await failing(
      new Request(`https://app.overturn.test/gorgias/widget?ticket_id=48213&token=${TOKEN}`),
    );
    const data = (await res.json()) as Record<string, string>;
    expect(data.status).toBe("Draft inserted · 12 words");
    expect(data.detail).toContain("Could not read this ticket");
  });

  it("skips internal notes, and captures them when the installer asked", async () => {
    const note: MessageSnapshot = { ...sentReply, id: 10, public: false, text: sentText };
    const skipped = harness({ run: recordedDraft, messages: [customerMessage, note] });
    await widget(skipped);
    expect(skipped.captures).toHaveLength(0);

    const asked = harness({
      run: recordedDraft,
      messages: [customerMessage, note],
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        capture_internal_notes: "true",
        require_reason: "false",
      }),
    });
    await widget(asked);
    expect(asked.captures[0]?.tags).toEqual(["draft:recorded", "internal-note"]);
  });
});

describe("state that survives a restart", () => {
  it("files a capture waiting for its reason after the process comes back", async () => {
    const store = createMemoryStore();
    const before = harness({ run: recordedDraft, messages: [customerMessage, sentReply], store });
    await widget(before);
    expect(before.captures).toHaveLength(0); // held, waiting for a reason

    // Same store, brand-new process: nothing read from Gorgias, the held body is still there.
    const after = harness({
      run: null,
      store,
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        require_reason: "false",
      }),
    });
    const path = signer.reason(48213, "wrong_answer");
    await after.handler(post(path, {}));
    expect(after.captures).toHaveLength(1);
    expect(after.captures[0]?.sent.text).toBe(sentText);
    expect(after.captures[0]?.reasonCode).toBe("wrong_answer");
  });

  it("keeps a save the agent made before the restart", async () => {
    const store = createMemoryStore();
    const first = harness({
      run: null,
      store,
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        min_draft_chars: "40",
      }),
    });
    const draftPath = signer.draft(48213);
    const saved = await first.handler(post(draftPath, { source: "assist", text: draftText }));
    expect(await saved.text()).toContain("Draft saved");

    const second = harness({ run: null, store, settings });
    const { data } = await widget(second);
    expect(data.status).toBe("Draft inserted · 12 words");
  });
});

describe("the app's own routes", () => {
  it("answers health and refuses everything else", async () => {
    const h = harness({ run: null });
    expect(await (await h.handler(new Request("https://app.overturn.test/health"))).json()).toEqual({
      ok: true,
      agent: "support-reply",
    });
    expect((await h.handler(new Request("https://app.overturn.test/gorgias/nope"))).status).toBe(404);
    expect((await h.handler(new Request("https://app.overturn.test/"))).status).toBe(404);
    expect((await widget(h, "ticket_id=48213")).res.status).toBe(403);
    expect((await widget(h, "ticket_id=48213&token=wrong")).res.status).toBe(403);
  });

  it("refuses a link that was not signed, was tampered with, or has expired", async () => {
    const h = harness({ run: recordedDraft });
    expect(
      (
        await h.handler(
          new Request("https://app.overturn.test/gorgias/reason?ticket_id=48213&code=wrong_answer"),
        )
      ).status,
    ).toBe(403);

    // The code is part of what was signed, so swapping it invalidates the link.
    const good = signer.reason(48213, "wrong_answer");
    const tampered = good.replace("wrong_answer", "tone_wording");
    expect(tampered).not.toBe(good);
    expect((await h.handler(new Request(`https://app.overturn.test${tampered}`))).status).toBe(403);

    // A link signed a long time ago does not keep working.
    const expired = linkSigner(TOKEN, () => 0).reason(48213, "wrong_answer");
    expect((await h.handler(new Request(`https://app.overturn.test${expired}`))).status).toBe(403);

    // The live link still works, and the token itself is nowhere in it.
    expect(good).not.toContain(TOKEN);
    expect((await h.handler(new Request(`https://app.overturn.test${good}`))).status).toBe(200);
  });

  it("takes the draft by hand and asks where the text came from", async () => {
    const h = harness({
      run: null,
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        min_draft_chars: "40",
      }),
    });
    const path = signer.draft(48213);
    const form = await h.handler(new Request(`https://app.overturn.test${path}`));
    const html = await form.text();
    expect(html).toContain("The AI wrote it");
    expect(html).toContain("I wrote it");

    const noSource = await h.handler(post(path, { text: draftText }));
    expect(await noSource.text()).toContain("Say where the text came from");

    const tooShort = await h.handler(post(path, { source: "assist", text: "Hi!" }));
    expect(await tooShort.text()).toContain("shorter than 40 characters");

    const saved = await h.handler(post(path, { source: "assist", text: draftText }));
    expect(await saved.text()).toContain("Draft saved · 12 words");

    const { data } = await widget(h);
    expect(data.status).toBe("Draft inserted · 12 words");
  });

  it("keeps an unknown source unknown rather than calling it AI", async () => {
    const h = harness({
      run: null,
      settings: settingsFrom({
        app_url: "https://app.overturn.test",
        widget_token: TOKEN,
        require_reason: "false",
        min_draft_chars: "40",
      }),
    });
    await h.handler(post(signer.draft(48213), { source: "unknown", text: draftText }));
    // The agent pastes, then sends: the reply lands after the draft was saved.
    h.setMessages([
      customerMessage,
      { ...sentReply, createdAt: "2026-10-01T15:00:00Z", sentAt: "2026-10-01T15:00:00Z" },
    ]);
    await widget(h);
    expect(h.captures).toHaveLength(1);
    expect(h.captures[0]?.tags).toEqual(["draft:unknown", "public-reply"]);
  });
});
