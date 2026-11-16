import { type AppSettings, type MessageSnapshot, stripHtml, type TicketSnapshot } from "./capture";

/** The Gorgias REST API: the ticket's fields, and the messages that say what was actually sent. */
export interface GorgiasClient {
  ticket(id: string | number): Promise<TicketSnapshot>;
  messages(id: string | number): Promise<MessageSnapshot[]>;
}

export interface GorgiasCredentials {
  /** The helpdesk domain: `acme` or `acme.gorgias.com`. */
  domain: string;
  /** The REST API user (their email), from Settings → REST API. */
  email: string;
  /** The REST API key. Never leaves the app's environment. */
  apiKey: string;
}

export class GorgiasError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "GorgiasError";
    this.status = status;
  }
}

/** `acme`, `acme.gorgias.com` and `https://acme.gorgias.com` all mean the same helpdesk. */
export function gorgiasBase(domain: string): string {
  const trimmed = domain.trim().replace(/\/+$/, "");
  if (!trimmed) throw new GorgiasError("gorgias domain is not set", 0);
  const withScheme = /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const host = new URL(withScheme).host;
  return host.endsWith(".gorgias.com") ? `https://${host}` : `https://${host}.gorgias.com`;
}

interface ApiTag {
  name?: string | null;
}

interface ApiMessage {
  id?: number | string | null;
  public?: boolean | null;
  from_agent?: boolean | null;
  sender?: { email?: string | null; name?: string | null } | null;
  created_datetime?: string | null;
  sent_datetime?: string | null;
  failed_datetime?: string | null;
  last_sending_error?: unknown;
  stripped_text?: string | null;
  body_text?: string | null;
  body_html?: string | null;
}

interface ApiTicket {
  id: number | string;
  subject?: string | null;
  customer?: { email?: string | null; name?: string | null } | null;
  messages?: ApiMessage[] | null;
  tags?: Array<string | ApiTag> | null;
  custom_fields?: Record<string, unknown> | null;
}

/** The text of a message: Gorgias' signature-stripped text, else the text, else the HTML read as text. */
export function messageText(m: ApiMessage): string {
  const plain = m.stripped_text?.trim() || m.body_text?.trim();
  if (plain) return plain;
  return m.body_html ? stripHtml(m.body_html) : "";
}

/**
 * Gorgias decouples creating a message from sending it: `sent_datetime` is filled only once the
 * message actually went out, and `failed_datetime` / `last_sending_error` say when it did not. The
 * app keeps both, because a capture must never be recorded for a reply the customer never got.
 */
export function messageSnapshotFrom(m: ApiMessage): MessageSnapshot {
  return {
    id: m.id ?? undefined,
    public: m.public !== false,
    fromAgent: m.from_agent === true,
    senderName: m.sender?.name ?? null,
    senderEmail: m.sender?.email ?? null,
    sentAt: m.sent_datetime ?? null,
    failedAt: m.failed_datetime ?? (m.last_sending_error ? "sending-error" : null),
    createdAt: m.created_datetime ?? null,
    text: messageText(m),
  };
}

function tagName(t: string | ApiTag): string | null {
  const name = typeof t === "string" ? t : t.name;
  return name?.trim() ? name.trim() : null;
}

function fieldValue(fields: Record<string, unknown> | null, id: string): unknown {
  const raw = fields?.[id];
  // A custom field value is a bare scalar or `{ value: … }`, depending on the field type.
  if (raw && typeof raw === "object" && "value" in raw) return (raw as { value?: unknown }).value ?? null;
  return raw ?? null;
}

/** The REST ticket as the app's own snapshot: everything capture needs, nothing else. */
export function ticketSnapshotFrom(
  ticket: ApiTicket,
  settings: AppSettings,
  opts: { base?: string } = {},
): TicketSnapshot {
  const id = ticket.id;
  const fields = ticket.custom_fields ?? null;
  return {
    id,
    subject: ticket.subject ?? null,
    customerEmail: ticket.customer?.email ?? null,
    customerName: ticket.customer?.name ?? null,
    messages: (ticket.messages ?? []).map(messageSnapshotFrom),
    fields: Object.fromEntries(settings.decisionFields.map((f) => [f.label, fieldValue(fields, f.id)])),
    order: Object.fromEntries(settings.orderFields.map((f) => [f.label, fieldValue(fields, f.id)])),
    tags: (ticket.tags ?? []).map(tagName).filter((t): t is string => t !== null),
    url: opts.base ? `${opts.base}/app/tickets/${id}` : null,
  };
}

/** The REST API client the app reads tickets with. */
export function createGorgiasClient(
  creds: GorgiasCredentials,
  settings: AppSettings,
  fetchImpl: typeof fetch = fetch,
): GorgiasClient {
  const base = gorgiasBase(creds.domain);
  const authorization = `Basic ${Buffer.from(`${creds.email}:${creds.apiKey}`, "utf8").toString("base64")}`;

  async function get<T>(path: string, what: string): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      headers: { Authorization: authorization, Accept: "application/json" },
    });
    if (!res.ok) throw new GorgiasError(`Gorgias returned ${res.status} for ${what}`, res.status);
    return (await res.json()) as T;
  }

  return {
    async ticket(id) {
      return ticketSnapshotFrom(
        await get<ApiTicket>(`/api/tickets/${encodeURIComponent(String(id))}`, `ticket ${id}`),
        settings,
        { base },
      );
    },
    /**
     * The flat message list, newest first: the small read the send check needs. `sent_datetime` is
     * what tells a reply that went out from one that is still being created.
     */
    async messages(id) {
      const query = `ticket_id=${encodeURIComponent(String(id))}&order_by=created_datetime%3Adesc&limit=10`;
      const body = await get<{ data?: ApiMessage[] }>(`/api/messages?${query}`, `messages of ticket ${id}`);
      // The list is newest first; the diff wants the thread the way the human read it.
      return (body.data ?? []).map(messageSnapshotFrom).reverse();
    },
  };
}
