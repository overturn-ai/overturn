import type { GorgiasMessage, GorgiasOrder, TicketSnapshot } from "./capture";

/** What the app needs from Gorgias. Small enough to mock in a test. */
export interface GorgiasClient {
  /** The ticket with its thread, as the capture sees it. */
  getTicket(id: string): Promise<TicketSnapshot>;
}

export interface GorgiasClientOptions {
  /** The account's base API URL, e.g. `https://shop.gorgias.com/api`. */
  baseUrl: string;
  /** The API username (an email address) and the API key from the REST API settings. */
  apiUser: string;
  apiKey: string;
  /** Injected so a test can run the client without a network. */
  fetch?: typeof fetch;
}

function readString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function readRecord(source: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = source[key];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** The shop orders the customer has, newest last, across every shop integration. */
export function ordersFrom(customer: Record<string, unknown> | null): GorgiasOrder[] {
  if (!customer) return [];
  const integrations = readRecord(customer, "integrations");
  if (!integrations) return [];
  const orders: GorgiasOrder[] = [];
  for (const [provider, value] of Object.entries(integrations)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const list = (value as Record<string, unknown>).orders;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const order = entry as Record<string, unknown>;
      const id = readString(order, ["id", "order_id", "number"]);
      if (!id) continue;
      const lineItems = order.line_items;
      orders.push({
        id,
        provider,
        total: readString(order, ["total_price", "total", "total_set"]),
        currency: readString(order, ["currency", "currency_code"]),
        itemCount: Array.isArray(lineItems) ? lineItems.length : null,
        createdAt: readString(order, ["created_at", "created_datetime"]),
      });
    }
  }
  return orders;
}

/** The thread, as the capture sees it. */
export function messagesFrom(list: unknown): GorgiasMessage[] {
  if (!Array.isArray(list)) return [];
  const messages: GorgiasMessage[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const message = entry as Record<string, unknown>;
    const body = readString(message, ["body_text", "body", "text"]);
    if (!body) continue;
    const sender = readRecord(message, "sender") ?? readRecord(message, "author");
    const customer = readRecord(message, "customer");
    const type = readString(message, ["type"]);
    messages.push({
      id: readString(message, ["id"]) ?? undefined,
      bodyText: body,
      fromAgent: message.from_agent === true,
      isNote: type === "note",
      authorEmail: readString(sender ?? {}, ["email"]) ?? readString(customer ?? {}, ["email"]),
      authorName:
        readString(sender ?? {}, ["name", "firstname"]) ?? readString(customer ?? {}, ["name", "firstname"]),
      createdAt: readString(message, ["created_datetime", "created_at", "sent_datetime"]),
    });
  }
  return messages;
}

/**
 * The Gorgias client the app talks to.
 *
 * Two calls make a ticket: the ticket itself (`GET /api/tickets/{id}`, which carries the
 * customer and the shop orders) and its thread (`GET /api/tickets/{id}/messages`). Gorgias
 * lists messages after they were sent, so the reply is always read after the fact.
 */
export function createGorgiasClient(options: GorgiasClientOptions): GorgiasClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const headers = {
    Authorization: `Basic ${Buffer.from(`${options.apiUser}:${options.apiKey}`).toString("base64")}`,
    Accept: "application/json",
  };
  return {
    async getTicket(id: string): Promise<TicketSnapshot> {
      const ticketResponse = await doFetch(`${base}/tickets/${encodeURIComponent(id)}`, { headers });
      if (!ticketResponse.ok) throw new Error(`Gorgias answered ${ticketResponse.status}`);
      const ticket = (await ticketResponse.json()) as Record<string, unknown>;
      const customer = readRecord(ticket, "customer");
      const messagesResponse = await doFetch(`${base}/tickets/${encodeURIComponent(id)}/messages`, {
        headers,
      });
      const messages = messagesResponse.ok ? await messagesResponse.json() : [];
      const rawTags = ticket.tags;
      const tags = Array.isArray(rawTags)
        ? rawTags
            .map((tag) => {
              if (typeof tag === "string") return tag;
              if (tag && typeof tag === "object") {
                const name = (tag as Record<string, unknown>).name;
                return typeof name === "string" ? name : null;
              }
              return null;
            })
            .filter((tag): tag is string => typeof tag === "string")
        : [];
      const ticketId = readString(ticket, ["id"]) ?? id;
      const customerName =
        readString(customer ?? {}, ["name"]) ??
        ([readString(customer ?? {}, ["firstname"]), readString(customer ?? {}, ["lastname"])]
          .filter(Boolean)
          .join(" ") ||
          null);
      return {
        id: ticketId,
        subject: readString(ticket, ["subject"]),
        customerEmail: readString(customer ?? {}, ["email"]),
        customerName,
        assigneeEmail: readString(readRecord(ticket, "assignee_user") ?? {}, ["email"]),
        messages: messagesFrom(messages),
        tags,
        orders: ordersFrom(customer),
        fields: {},
        url: readString(ticket, ["url"]),
      };
    },
  };
}
