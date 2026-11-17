import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** One ticket message, as Gorgias's REST API returns it. */
export interface GorgiasMessage {
  id: number | string;
  /** `email`, `chat`, `internal-note`, ... */
  channel?: string | null;
  from_agent?: boolean;
  public?: boolean;
  body_text?: string | null;
  body_html?: string | null;
  sender?: { email?: string | null; name?: string | null } | null;
  created_datetime?: string | null;
}

/** One order from the customer's ecommerce integration (Shopify, BigCommerce, Magento...). */
export interface OrderSummary {
  id: string;
  name: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  total: string | null;
  currency: string | null;
  createdAt: string | null;
}

/** What the app knows about the ticket. */
export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  customerEmail: string | null;
  customerName: string | null;
  /** Oldest first. */
  messages: GorgiasMessage[];
  /** The customer's recent orders, newest first; ecommerce teams decide on these. */
  orders: OrderSummary[];
  /** Ticket custom fields the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold a changed reply's capture until the agent picks a reason (Gorgias's send is never held). */
  requireReason: boolean;
  captureInternalNotes: boolean;
  /** `field_id:label` pairs → ticket custom fields that are the decision. */
  decisionFields: Array<{ id: string; label: string }>;
  minDraftChars: number;
  /** Support pack by default: ecommerce teams are the first users here. */
  reasonPack: ReasonPack;
  /** How many of the customer's orders ride along as context. */
  maxOrders: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  reasonPack: "support",
  maxOrders: 3,
};

export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (k: string, d: boolean): boolean => {
    const v = raw[k];
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return d;
  };
  const num = (k: string, d: number): number => {
    const n = Number(str(k) ?? "");
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: num("min_draft_chars", DEFAULT_SETTINGS.minDraftChars),
    reasonPack: reasonPackFrom(str("reason_pack")),
    maxOrders: num("max_orders", DEFAULT_SETTINGS.maxOrders),
  };
}

/**
 * Where the draft came from. `recorded`: a drafting agent recorded its run with the SDK;
 * `inserted`: the drafting tool handed it to this app (`POST /draft`) as it put it in the reply box.
 * Both count as AI drafts in the scorecard.
 */
export type DraftOrigin = "recorded" | "inserted";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  /** ms epoch. */
  at: number;
}

export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

export function messageText(m: GorgiasMessage): string {
  if (m.body_text?.trim()) return normalizeCaptureText(m.body_text);
  return stripHtml(m.body_html ?? "");
}

export function isNote(m: GorgiasMessage): boolean {
  return m.channel === "internal-note" || m.public === false;
}

function role(m: GorgiasMessage): CaptureMessage["role"] {
  if (isNote(m)) return "note";
  return m.from_agent ? "agent" : "customer";
}

export function ordersLine(orders: OrderSummary[]): string {
  return orders
    .map((o) =>
      [
        o.name ?? `#${o.id}`,
        o.total ? `${o.total}${o.currency ? ` ${o.currency}` : ""}` : null,
        o.financialStatus,
        o.fulfillmentStatus ?? "unfulfilled",
        o.createdAt ? `placed ${o.createdAt.slice(0, 10)}` : null,
      ]
        .filter(Boolean)
        .join(", "),
    )
    .join("\n");
}

/** The thread the agent saw, oldest first, with the customer's orders first as system context. */
export function contextFrom(t: TicketSnapshot): CaptureMessage[] {
  const out: CaptureMessage[] = [];
  if (t.orders.length)
    out.push({
      role: "system",
      author: null,
      content: `Customer orders:\n${ordersLine(t.orders)}`,
      at: null,
    });
  for (const m of t.messages) {
    const content = messageText(m);
    if (!content) continue;
    out.push({
      role: role(m),
      author: m.sender?.email ?? m.sender?.name ?? null,
      content,
      at: m.created_datetime ?? null,
    });
  }
  return out;
}

/**
 * The customer's orders from the ticket's `customer.integrations` (keyed by integration id).
 * Only the fields a support decision turns on are kept; no addresses, no payment details.
 */
export function ordersFrom(integrations: unknown, max: number): OrderSummary[] {
  if (!integrations || typeof integrations !== "object") return [];
  const orders: OrderSummary[] = [];
  const s = (v: unknown): string | null =>
    typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;
  for (const data of Object.values(integrations as Record<string, unknown>)) {
    const list = (data as { orders?: unknown } | null)?.orders;
    if (!Array.isArray(list)) continue;
    for (const o of list as Array<Record<string, unknown>>) {
      const id = s(o.id);
      if (!id) continue;
      orders.push({
        id,
        name: s(o.name),
        financialStatus: s(o.financial_status),
        fulfillmentStatus: s(o.fulfillment_status),
        total: s(o.total_price),
        currency: s(o.currency),
        createdAt: s(o.created_at),
      });
    }
  }
  return orders.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, max);
}

/** Decision-field values from Gorgias's `custom_fields` (`{ [id]: { id, value } }`), by label. */
export function fieldsFrom(customFields: unknown, settings: AppSettings): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  const cf = (customFields && typeof customFields === "object" ? customFields : {}) as Record<
    string,
    { value?: unknown } | undefined
  >;
  return Object.fromEntries(settings.decisionFields.map((f) => [f.label, cf[f.id]?.value ?? null]));
}

export interface PendingSend {
  text: string;
  type: "reply" | "note";
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

export function decideOnSend(input: {
  ticket: TicketSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const { ticket, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "note" && !settings.captureInternalNotes) return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }
  const body: CaptureCreate = {
    source: "gorgias",
    externalId: `gr:${ticket.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: ticket.subject,
    context: contextFrom(ticket),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: ticket.url,
    tags: [`draft:${draft.origin}`, send.type === "note" ? "internal-note" : "public-reply"],
    metadata: {
      customer: ticket.customerEmail ?? ticket.customerName ?? null,
      orders: ticket.orders.map((o) => ({
        id: o.id,
        name: o.name,
        financialStatus: o.financialStatus,
        fulfillmentStatus: o.fulfillmentStatus,
        total: o.total,
        currency: o.currency,
      })),
    },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

export function statusLine(
  d: DraftState | null,
  lastResult: { changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  return `Draft inserted · ${stripHtml(d.text).split(/\s+/).filter(Boolean).length} words`;
}

export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}

/** A reason can also come from a ticket tag such as `overturn:wrong_answer` (e.g. set by a macro). */
export function reasonFromTags(
  tags: ReadonlyArray<{ name?: string } | string>,
  settings: AppSettings,
): string | null {
  const codes = new Set(quickReasons(settings).map((r) => r.code));
  for (const t of tags) {
    const name = typeof t === "string" ? t : (t.name ?? "");
    const m = /^overturn:([a-z0-9_]+)$/.exec(name.trim().toLowerCase());
    if (m && codes.has(m[1]!)) return m[1]!;
  }
  return null;
}
