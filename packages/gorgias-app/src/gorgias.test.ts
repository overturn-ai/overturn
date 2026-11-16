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
        body_text: "Second damaged lid this month.",
      }),
    ).toEqual({
      id: 9,
      public: false,
      fromAgent: true,
      senderName: "Ray",
      senderEmail: "ray@acme.com",
      createdAt: "2026-10-01T10:05:00Z",
      text: "Second damaged lid this month.",
    });
    expect(messageSnapshotFrom({}).public).toBe(true);
    expect(messageSnapshotFrom({}).fromAgent).toBe(false);
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
