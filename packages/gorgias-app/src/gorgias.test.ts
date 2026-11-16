import { describe, expect, it } from "vitest";
import { settingsFrom } from "./capture";
import {
  createGorgiasClient,
  GorgiasError,
  gorgiasBase,
  messageSnapshotFrom,
  messageText,
  ticketSnapshotFrom,
} from "./gorgias";

describe("the Gorgias REST API", () => {
  it("turns a domain into the helpdesk's API base", () => {
    expect(gorgiasBase("acme")).toBe("https://acme.gorgias.com");
    expect(gorgiasBase("acme.gorgias.com")).toBe("https://acme.gorgias.com");
    expect(gorgiasBase("https://acme.gorgias.com/")).toBe("https://acme.gorgias.com");
    expect(() => gorgiasBase("  ")).toThrow(GorgiasError);
  });

  it("prefers the signature-stripped text, and reads html when there is none", () => {
    expect(messageText({ stripped_text: "Thanks!", body_text: "Thanks! -- Ray" })).toBe("Thanks!");
    expect(messageText({ body_text: "Thanks!" })).toBe("Thanks!");
    expect(messageText({ body_html: "<p>Thanks&nbsp;Dana</p>" })).toBe("Thanks Dana");
    expect(messageText({})).toBe("");
  });

  it("maps a message: a public reply is the thread, an internal note is a note", () => {
    expect(
      messageSnapshotFrom({
        id: 9,
        public: false,
        from_agent: true,
        sender: { email: "ray@acme.com", name: "Ray" },
        created_datetime: "2026-10-01T10:05:00Z",
        sent_datetime: "2026-10-01T10:06:00Z",
        failed_datetime: null,
        body_text: "Second damaged lid this month.",
      }),
    ).toEqual({
      id: 9,
      public: false,
      fromAgent: true,
      senderName: "Ray",
      senderEmail: "ray@acme.com",
      sentAt: "2026-10-01T10:06:00Z",
      failedAt: null,
      createdAt: "2026-10-01T10:05:00Z",
      text: "Second damaged lid this month.",
    });
    expect(messageSnapshotFrom({}).public).toBe(true);
    expect(messageSnapshotFrom({}).fromAgent).toBe(false);
  });

  it("keeps what Gorgias says about sending: created is not sent, and a failure is a failure", () => {
    // Created but not sent yet: no sent_datetime.
    expect(messageSnapshotFrom({ id: 9, created_datetime: "2026-10-01T13:00:00Z" }).sentAt).toBeNull();
    // Gorgias reports the sending error on the message, not only in failed_datetime.
    expect(messageSnapshotFrom({ id: 9, last_sending_error: { msg: "relay refused" } }).failedAt).toBe(
      "sending-error",
    );
  });

  it("maps a ticket: decision fields and order context by label", () => {
    const settings = settingsFrom({
      decision_fields: "status:status",
      order_fields: "4509:order_id, 4510:shipping",
    });
    const snapshot = ticketSnapshotFrom(
      {
        id: 48213,
        subject: "Cracked lid",
        customer: { email: "dana@example.com", name: "Dana" },
        tags: ["vip", { name: "ai_drafted" }, { name: "  " }],
        custom_fields: { status: "processing", 4509: { value: "4509" }, 4510: "in_transit" },
        messages: [{ id: 1, public: true, from_agent: false, body_text: "The lid arrived cracked." }],
      },
      settings,
      { base: "https://acme.gorgias.com" },
    );
    expect(snapshot).toMatchObject({
      id: 48213,
      subject: "Cracked lid",
      customerEmail: "dana@example.com",
      customerName: "Dana",
      tags: ["vip", "ai_drafted"],
      fields: { status: "processing" },
      order: { order_id: "4509", shipping: "in_transit" },
      url: "https://acme.gorgias.com/app/tickets/48213",
    });
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]?.text).toBe("The lid arrived cracked.");
  });

  it("reads the ticket with the account's REST credentials", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const client = createGorgiasClient(
      { domain: "acme", email: "api@acme.com", apiKey: "key" },
      settingsFrom({ order_fields: "4509:order_id" }),
      (async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return new Response(JSON.stringify({ id: 48213, custom_fields: { 4509: "4509" }, messages: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    );
    const ticket = await client.ticket(48213);
    expect(calls[0]?.url).toBe("https://acme.gorgias.com/api/tickets/48213");
    expect(calls[0]?.headers.Authorization).toBe(
      `Basic ${Buffer.from("api@acme.com:key").toString("base64")}`,
    );
    expect(ticket.order).toEqual({ order_id: "4509" });
  });

  it("reads the message list newest first, and hands it back oldest first", async () => {
    const calls: string[] = [];
    const client = createGorgiasClient(
      { domain: "acme", email: "api@acme.com", apiKey: "key" },
      settingsFrom({}),
      (async (url: string) => {
        calls.push(url);
        return new Response(
          JSON.stringify({
            data: [
              { id: 9, from_agent: true, sent_datetime: "2026-10-01T13:00:00Z", body_text: "sent" },
              { id: 8, from_agent: true, body_text: "still being created" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    );
    const messages = await client.messages(48213);
    expect(calls[0]).toContain("/api/messages?ticket_id=48213&order_by=created_datetime%3Adesc&limit=10");
    // The API answers newest first; the app wants the thread the way the human read it.
    expect(messages.map((m) => m.id)).toEqual([8, 9]);
    expect(messages[1]?.sentAt).toBe("2026-10-01T13:00:00Z");
    expect(messages[0]?.sentAt).toBeNull();
  });

  it("says which ticket it could not read", async () => {
    const client = createGorgiasClient(
      { domain: "acme", email: "api@acme.com", apiKey: "key" },
      settingsFrom({}),
      (async () => new Response("nope", { status: 404 })) as typeof fetch,
    );
    await expect(client.ticket(1)).rejects.toThrow(/404/);
    await expect(client.ticket(1)).rejects.toBeInstanceOf(GorgiasError);
  });
});
