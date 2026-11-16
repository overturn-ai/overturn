import { type AppSettings, type MessageSnapshot, stripHtml, type TicketSnapshot } from "./capture";

/** The slice of the Gorgias REST API this app reads. https://developers.gorgias.com/reference */
export interface GorgiasClient {
  /** The ticket as the agent sees it: thread, customer, tags and the fields in the sidebar. */
  ticket(id: string | number): Promise<TicketSnapshot>;
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

/** Gorgias messages are already in order, oldest first; the app keeps that order. */
export function messageSnapshotFrom(m: ApiMessage): MessageSnapshot {
  return {
    id: m.id ?? undefined,
    public: m.public !== false,
    fromAgent: m.from_agent === true,
    senderName: m.sender?.name ?? null,
    senderEmail: m.sender?.email ?? null,
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
  return {
    async ticket(id) {
      const url = `${base}/api/tickets/${encodeURIComponent(String(id))}`;
      const res = await fetchImpl(url, {
        headers: { Authorization: authorization, Accept: "application/json" },
      });
      if (!res.ok) {
        throw new GorgiasError(`Gorgias returned ${res.status} for ticket ${id}`, res.status);
      }
      const ticket = (await res.json()) as ApiTicket;
      return ticketSnapshotFrom(ticket, settings, { base });
    },
  };
}
