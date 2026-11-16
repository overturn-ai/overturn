import {
  type AppSettings,
  type GorgiasMessage,
  type GorgiasOrder,
  isoAt,
  type TicketSnapshot,
} from "./capture";

/**
 * The slice of the Gorgias REST API this app reads. Gorgias has no browser SDK with a submit
 * hook, so the app reads the ticket through the API with the account's own credentials and
 * finds the reply in the thread after the fact (see capture.ts).
 *
 * The API is Basic-authenticated with the account's email and API key, both of which the
 * account admin keeps in the widget settings; nothing is sent to a browser that does not
 * already hold them.
 */
export interface GorgiasClientOptions {
  /** e.g. `https://acme.gorgias.com`. */
  baseUrl: string;
  /** The account email the API key belongs to. */
  username: string;
  /** The REST API key. */
  apiKey: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface GorgiasClient {
  getTicket(id: number | string): Promise<TicketSnapshot>;
}

interface RawMessage {
  id?: number | string;
  body_text?: string | null;
  body_html?: string | null;
  channel?: string | null;
  from_agent?: boolean | null;
  via?: string | null;
  sender?: { email?: string | null; name?: string | null } | null;
  created_datetime?: string | null;
}

interface RawOrder {
  id?: number | string;
  integration_id?: number | string | null;
  provider?: string | null;
  total_price?: string | number | null;
  currency?: string | null;
  items?: unknown[] | null;
  created_datetime?: string | null;
}

interface RawTicket {
  id: number | string;
  subject?: string | null;
  customer?: { email?: string | null; name?: string | null } | null;
  assignee_user?: { email?: string | null } | null;
  tags?: Array<{ name?: string } | string> | null;
  messages?: RawMessage[] | null;
  customer_integrations?: Array<{ provider?: string | null; orders?: RawOrder[] | null }> | null;
}

function basicAuth(username: string, apiKey: string): string {
  // btoa is available in the widget iframe and in Node 18+; the key never leaves this header.
  return `Basic ${btoa(`${username}:${apiKey}`)}`;
}

/** A private note is written on the `internal-note` channel; everything else is a reply. */
function isNote(message: RawMessage): boolean {
  return message.channel === "internal-note" || message.via === "internal-note";
}

/** Gorgias reports an agent message with `from_agent: true`; sender role is a fallback. */
function fromAgent(message: RawMessage): boolean {
  if (typeof message.from_agent === "boolean") return message.from_agent;
  return message.via === "agent" || message.channel === "email";
}

function toMessages(raw: RawMessage[] | null | undefined): GorgiasMessage[] {
  const messages = (raw ?? []).map((m) => ({
    id: m.id,
    bodyText: (m.body_text ?? "").trim(),
    fromAgent: fromAgent(m),
    isNote: isNote(m),
    authorEmail: m.sender?.email ?? null,
    authorName: m.sender?.name ?? null,
    createdAt: m.created_datetime ?? null,
  }));
  // Gorgias returns newest first; the case wants oldest first, the order the agent read it.
  return messages.reverse();
}

function toOrders(raw: RawTicket): GorgiasOrder[] {
  const orders: GorgiasOrder[] = [];
  for (const integration of raw.customer_integrations ?? []) {
    for (const order of integration.orders ?? []) {
      if (order.id === undefined || order.id === null) continue;
      orders.push({
        id: order.id,
        provider: integration.provider ?? String(order.integration_id ?? "unknown"),
        total: order.total_price ?? null,
        currency: order.currency ?? null,
        itemCount: Array.isArray(order.items) ? order.items.length : null,
        createdAt: isoAt(order.created_datetime),
      });
    }
  }
  // Newest order last, so `orderContext` can pick the tail.
  return orders.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/** Reads one ticket and normalizes it into the snapshot the capture logic consumes. */
export function createGorgiasClient(opts: GorgiasClientOptions): GorgiasClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    async getTicket(id) {
      const res = await doFetch(`${base}/api/tickets/${id}`, {
        headers: { Authorization: basicAuth(opts.username, opts.apiKey), Accept: "application/json" },
      });
      if (!res.ok) throw Object.assign(new Error(`gorgias ${res.status}`), { status: res.status });
      const raw = (await res.json()) as RawTicket;
      const tags = (raw.tags ?? []).map((t) => (typeof t === "string" ? t : (t.name ?? ""))).filter(Boolean);
      return {
        id: raw.id,
        subject: raw.subject ?? null,
        customerEmail: raw.customer?.email ?? null,
        customerName: raw.customer?.name ?? null,
        assigneeEmail: raw.assignee_user?.email ?? null,
        messages: toMessages(raw.messages),
        tags,
        orders: toOrders(raw),
        fields: {},
        url: `${base}/app/tickets/${raw.id}`,
      };
    },
  };
}

/** The settings the REST client needs, read from the same bag as the app settings. */
export function gorgiasCredentials(
  raw: Record<string, unknown>,
): { username: string; apiKey: string } | null {
  const username = typeof raw.gorgias_username === "string" ? raw.gorgias_username.trim() : "";
  const apiKey = typeof raw.gorgias_api_key === "string" ? raw.gorgias_api_key.trim() : "";
  if (!username || !apiKey) return null;
  return { username, apiKey };
}

export type { AppSettings };
