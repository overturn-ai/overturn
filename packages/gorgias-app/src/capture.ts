import type { CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/**
 * The Gorgias capture logic: pure, no I/O, tested in capture.test.ts. handler.ts is the glue.
 *
 * Gorgias gives third parties no client-side app framework: a sidebar widget renders JSON that
 * an HTTP integration returned, plus custom action buttons, and HTTP integrations fire on
 * ticket events. So the draft is read from the ticket (an internal note from the drafting AI,
 * or a run the drafting agent recorded with the SDK), the send is the agent's next public
 * message, and the capture happens after Gorgias has already sent it: it can never block it.
 */

/** A Gorgias message, as the REST API returns it (`GET /api/tickets/{id}`), only the fields used. */
export interface GorgiasMessage {
  id: number | string;
  channel?: string | null;
  via?: string | null;
  /** false for internal notes. */
  public?: boolean | null;
  from_agent?: boolean | null;
  sender?: { email?: string | null; name?: string | null } | null;
  body_text?: string | null;
  body_html?: string | null;
  stripped_text?: string | null;
  created_datetime?: string | null;
  sent_datetime?: string | null;
}

/** A Shopify (or other ecommerce) order as Gorgias stores it on the customer's integration data. */
export interface GorgiasOrder {
  id?: number | string | null;
  name?: string | null;
  order_number?: number | string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  total_price?: string | number | null;
  currency?: string | null;
  created_at?: string | null;
}

export interface GorgiasTicket {
  id: number | string;
  subject?: string | null;
  customer?: {
    email?: string | null;
    name?: string | null;
    /** Keyed by integration id; ecommerce integrations carry `orders`, newest first. */
    integrations?: Record<
      string,
      { __integration_type__?: string; orders?: GorgiasOrder[] | null } | null
    > | null;
  } | null;
  tags?: Array<{ name: string }> | null;
  messages?: GorgiasMessage[] | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** A changed reply is only captured once the agent picks a reason (the send itself is never held). */
  requireReason: boolean;
  /** Notes shorter than this are never a draft. */
  minDraftChars: number;
  /** When set, only tickets carrying this tag are captured. */
  scopeTag: string | null;
  reasonPack: ReasonPack;
  /** An internal note starting with this marker is the draft (the marker is stripped). */
  draftMarker: string;
  /** Senders whose internal notes are drafts (the drafting AI's Gorgias user), lower-cased. */
  draftAuthors: string[];
  /** The Gorgias account subdomain (`acme` for acme.gorgias.com), for links back to the ticket. */
  gorgiasDomain: string | null;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
  draftMarker: "[AI draft]",
  draftAuthors: [],
  gorgiasDomain: null,
};

/** Parses settings from snake_case keys (the handler maps its environment onto these). */
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
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
    draftMarker: str("draft_marker") ?? DEFAULT_SETTINGS.draftMarker,
    draftAuthors: (str("draft_authors") ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    gorgiasDomain: str("gorgias_domain"),
  };
}

export function externalIdFor(ticketId: number | string): string {
  return `gr:${ticketId}`;
}

export function inScope(ticket: GorgiasTicket, settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return (ticket.tags ?? []).some((t) => t.name === settings.scopeTag);
}

/** Gorgias bodies come as HTML (and as text); the case wants the text the human read. */
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
  if (m.body_html?.trim()) return stripHtml(m.body_html);
  return normalizeCaptureText(m.stripped_text ?? "");
}

export function isNote(m: GorgiasMessage): boolean {
  return m.channel === "internal-note" || m.public === false;
}

function isPublicAgentReply(m: GorgiasMessage): boolean {
  return m.from_agent === true && !isNote(m);
}

const at = (m: GorgiasMessage): string | null => m.sent_datetime ?? m.created_datetime ?? null;
const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

/** Messages oldest first (the API usually returns them so; this does not rely on it). */
export function chronological(messages: readonly GorgiasMessage[]): GorgiasMessage[] {
  return messages
    .map((m, i) => ({ m, i, t: time(at(m)) ?? 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * The draft text of a message, if it is one: an internal note that starts with the draft
 * marker, or one written by a configured drafting user, at least `minDraftChars` long.
 */
export function draftTextOf(m: GorgiasMessage, settings: AppSettings): string | null {
  if (!isNote(m)) return null;
  const text = messageText(m);
  const marker = settings.draftMarker;
  const sender = m.sender?.email?.toLowerCase() ?? "";
  let body: string | null = null;
  if (marker && text.toLowerCase().startsWith(marker.toLowerCase())) body = text.slice(marker.length).trim();
  else if (sender && settings.draftAuthors.includes(sender)) body = text;
  if (body === null || body.length < settings.minDraftChars) return null;
  return body;
}

export type DraftOrigin = "inserted" | "recorded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  /** When the draft landed (ms), for secondsToSend; null when unknown. */
  at: number | null;
  messageId?: number | string;
  runId?: string;
  model?: string | null;
}

/** A run the drafting agent recorded with the SDK under `externalId: "gr:<ticket id>"`. */
export interface RecordedRun {
  id: string;
  output: unknown;
  startedAt?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * A recorded run is the draft when its output is text. Runs that /v1/capture itself
 * synthesized (tagged `capture:<source>`) are not drafts: they are earlier captures.
 */
export function draftFromRun(run: RecordedRun | null | undefined): DraftState | null {
  if (!run || typeof run.output !== "string" || !run.output.trim()) return null;
  if ((run.tags ?? []).some((t) => t.startsWith("capture:"))) return null;
  const model = run.metadata?.model;
  return {
    text: run.output,
    origin: "recorded",
    at: time(run.startedAt),
    runId: run.id,
    model: typeof model === "string" ? model : null,
  };
}

export interface Exchange {
  draft: DraftState | null;
  /** The agent's first public reply after the draft; null while the draft is still waiting. */
  sent: GorgiasMessage | null;
  /** Whether `sent` is the newest message on the ticket (the event that woke us is that send). */
  sentIsLatest: boolean;
}

/**
 * The latest draft on the ticket and the reply that answered it. A draft from a note wins
 * over a recorded run when it is newer; a recorded run only pairs with a reply sent after it.
 */
export function latestExchange(
  ticket: GorgiasTicket,
  settings: AppSettings,
  recorded: DraftState | null = null,
): Exchange {
  const msgs = chronological(ticket.messages ?? []);
  let draftIdx = -1;
  let draft: DraftState | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const text = draftTextOf(msgs[i]!, settings);
    if (text !== null) {
      draftIdx = i;
      draft = { text, origin: "inserted", at: time(at(msgs[i]!)), messageId: msgs[i]!.id };
      break;
    }
  }
  if (recorded && (!draft || (recorded.at ?? 0) > (draft.at ?? 0))) {
    draft = recorded;
    // The run pairs with the first reply after it; with no start time, with the last reply.
    if (recorded.at === null) {
      let lastReply = -1;
      msgs.forEach((m, i) => {
        if (isPublicAgentReply(m)) lastReply = i;
      });
      draftIdx = lastReply >= 0 ? lastReply - 1 : msgs.length - 1;
    } else {
      draftIdx = msgs.findIndex((m) => (time(at(m)) ?? 0) >= (recorded.at ?? 0)) - 1;
      if (draftIdx < -1) draftIdx = msgs.length - 1;
    }
  }
  if (!draft) return { draft: null, sent: null, sentIsLatest: false };
  const sentIdx = msgs.findIndex((m, i) => i > draftIdx && isPublicAgentReply(m));
  if (sentIdx < 0) return { draft, sent: null, sentIsLatest: false };
  return { draft, sent: msgs[sentIdx]!, sentIsLatest: sentIdx === msgs.length - 1 };
}

function roleOf(m: GorgiasMessage): CaptureMessage["role"] {
  if (isNote(m)) return "note";
  return m.from_agent ? "agent" : "customer";
}

/** The newest order on the customer's ecommerce integrations, if any. */
export function latestOrder(ticket: GorgiasTicket): GorgiasOrder | null {
  const integrations = Object.values(ticket.customer?.integrations ?? {});
  let best: GorgiasOrder | null = null;
  for (const integ of integrations) {
    for (const o of integ?.orders ?? []) {
      if (!best || (time(o.created_at) ?? 0) > (time(best.created_at) ?? 0)) best = o;
    }
  }
  return best;
}

/** The order facts an ecommerce reply is about, as flat fields (nulls dropped). */
export function orderFields(order: GorgiasOrder | null): Record<string, string> {
  if (!order) return {};
  const raw: Record<string, unknown> = {
    order: order.name ?? (order.order_number != null ? `#${order.order_number}` : null),
    payment_status: order.financial_status,
    fulfillment_status: order.fulfillment_status,
    total:
      order.total_price != null ? `${order.total_price}${order.currency ? ` ${order.currency}` : ""}` : null,
    ordered_at: order.created_at,
  };
  return Object.fromEntries(
    Object.entries(raw).filter((e): e is [string, string | number] => e[1] != null && e[1] !== ""),
  ) as Record<string, string>;
}

/**
 * The thread the agent saw before sending, oldest first: the order as a system line, then
 * every message up to the send, minus the draft note itself (that is the `draft`).
 */
export function contextFrom(ticket: GorgiasTicket, exchange: Exchange): CaptureMessage[] {
  const out: CaptureMessage[] = [];
  const order = orderFields(latestOrder(ticket));
  if (Object.keys(order).length) {
    out.push({
      role: "system",
      author: null,
      content: `Order: ${Object.entries(order)
        .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
        .join(" · ")}`,
      at: null,
    });
  }
  for (const m of chronological(ticket.messages ?? [])) {
    if (exchange.sent && m.id === exchange.sent.id) break;
    if (exchange.draft?.messageId !== undefined && m.id === exchange.draft.messageId) continue;
    const content = messageText(m);
    if (!content) continue;
    out.push({ role: roleOf(m), author: m.sender?.email ?? m.sender?.name ?? null, content, at: at(m) });
  }
  return out;
}

export function ticketUrl(ticketId: number | string, settings: AppSettings): string | null {
  return settings.gorgiasDomain
    ? `https://${settings.gorgiasDomain}.gorgias.com/app/ticket/${ticketId}`
    : null;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "not-sent" | "empty" | "out-of-scope" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do about the latest exchange. Pure: the handler only forwards the answer. */
export function decideOnSend(input: {
  ticket: GorgiasTicket;
  exchange: Exchange;
  reasonCode: string | null;
  reason: string;
  /** Who sent it; defaults to the sender of the reply. */
  actor?: string | null;
  settings: AppSettings;
}): SendDecision {
  const { ticket, exchange, settings } = input;
  if (!inScope(ticket, settings)) return { action: "skip", why: "out-of-scope" };
  const { draft, sent } = exchange;
  if (!draft) return { action: "skip", why: "no-draft" };
  if (!sent) return { action: "skip", why: "not-sent" };
  const sentText = messageText(sent);
  if (!sentText) return { action: "skip", why: "empty" };

  const draftAnswer = { text: normalizeCaptureText(stripHtml(draft.text)) };
  const sentAnswer = { text: sentText };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }
  const sentAt = time(at(sent));
  const order = orderFields(latestOrder(ticket));
  const body: CaptureCreate = {
    source: "gorgias",
    externalId: externalIdFor(ticket.id),
    agent: settings.agent,
    actor: input.actor ?? sent.sender?.email ?? sent.sender?.name ?? null,
    subject: ticket.subject ?? null,
    context: contextFrom(ticket, exchange),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: input.reason.trim() || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend:
      draft.at !== null && sentAt !== null ? Math.max(0, Math.round((sentAt - draft.at) / 100) / 10) : null,
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: ticketUrl(ticket.id, settings),
    tags: [`draft:${draft.origin}`, `channel:${sent.channel ?? "unknown"}`],
    metadata: {
      requester: ticket.customer?.email ?? ticket.customer?.name ?? null,
      gorgiasMessageId: String(sent.id),
      ...(Object.keys(order).length ? { order } : {}),
    },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** The sidebar line, the same wording as the Zendesk app where the states match. */
export function statusLine(
  state:
    | { kind: "waiting" }
    | { kind: "draft"; draft: DraftState }
    | { kind: "need-reason" }
    | { kind: "captured"; changed: boolean; dedup: boolean }
    | { kind: "error"; status: number | "network" },
): string {
  switch (state.kind) {
    case "waiting":
      return "Waiting for a draft";
    case "draft": {
      const from = state.draft.origin === "recorded" ? "recorded by your agent" : "inserted";
      return `Draft ${from} · ${wordCount(state.draft.text)} words`;
    }
    case "need-reason":
      return "Changed · pick why below to save it";
    case "captured":
      if (!state.changed) return "Sent as drafted · approved";
      return state.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
    case "error":
      return `Overturn could not save this correction (${state.status}). The reply was sent.`;
  }
}

/** The chips the agent clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
