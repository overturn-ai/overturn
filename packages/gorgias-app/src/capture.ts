import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** Gorgias message representation (from REST API / webhook / widget). */
export interface GorgiasMessage {
  id?: number | string;
  body_text?: string | null;
  body_html?: string | null;
  stripped_text?: string | null;
  from_agent?: boolean;
  channel?: string | null;
  source?: { type?: string } | null;
  sender?: {
    id?: number | string;
    name?: string | null;
    email?: string | null;
    role?: string | null;
  } | null;
  created_datetime?: string | null;
}

/** Legacy / simplified comment format for compatibility. */
export interface GorgiasComment {
  id?: number | string;
  value: string;
  type?: "publicReply" | "internalNote" | string;
  authorName?: string | null;
  authorEmail?: string | null;
  isAgent?: boolean;
  createdAt?: string | null;
}

/** What the app knows about the Gorgias ticket. */
export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  customer?: {
    id?: number | string;
    email?: string | null;
    name?: string | null;
    firstname?: string | null;
    lastname?: string | null;
  } | null;
  /** Messages in the ticket (Gorgias API format). */
  messages?: GorgiasMessage[];
  /** Comments in the ticket (simplified format for testing or adapter bridges). */
  comments?: GorgiasComment[];
  /** Custom ticket fields by name or id. */
  fields?: Record<string, unknown>;
  /** Order context data (Shopify / BigCommerce / Gorgias ecommerce). */
  order?: {
    id?: string | number | null;
    order_number?: string | number | null;
    fulfillment_status?: string | null;
    financial_status?: string | null;
    tracking_number?: string | null;
    refund_amount?: number | string | null;
    total_price?: number | string | null;
    status?: string | null;
    [key: string]: unknown;
  } | Record<string, unknown> | null;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Require picking a reason when the draft was changed. Default is true. */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies. */
  captureInternalNotes: boolean;
  /** Custom fields that are the decision, as id:label pairs. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft. */
  minDraftChars: number;
  /** When set, only tickets carrying this tag are watched. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: defaults to 'support'. */
  reasonPack: ReasonPack;
  /** Order context field keys to capture from the ticket order/fields. */
  orderFields: string[];
}

export const DEFAULT_ORDER_FIELDS: readonly string[] = [
  "order_id",
  "order_number",
  "fulfillment_status",
  "financial_status",
  "tracking_number",
  "refund_amount",
  "return_status",
];

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
  orderFields: [...DEFAULT_ORDER_FIELDS],
};

/** Parses Gorgias app settings from raw parameters. */
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
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const orderFieldsRaw = str("order_fields");
  const orderFields = orderFieldsRaw
    ? orderFieldsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_ORDER_FIELDS];

  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
    orderFields,
  };
}

/** Whether the app should watch this ticket based on scope tags. */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now()) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized composer on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: first ? "preloaded" : "inserted", at: now };
        return draft;
      }
      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

/** HTML stripping utility to get clean human-readable text. */
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

/** Resolves role from a Gorgias message. */
function messageRole(m: GorgiasMessage): CaptureMessage["role"] {
  const channel = (m.channel ?? "").toLowerCase();
  const sourceType = (m.source?.type ?? "").toLowerCase();
  if (channel === "internal-note" || channel === "note" || sourceType === "internal-note") {
    return "note";
  }
  if (channel === "system") {
    return "system";
  }
  if (m.from_agent || m.sender?.role === "agent" || m.sender?.role === "admin") {
    return "agent";
  }
  return "customer";
}

/** Resolves role from a simplified comment format. */
function commentRole(c: GorgiasComment): CaptureMessage["role"] {
  if (c.type === "internalNote") return "note";
  return c.isAgent ? "agent" : "customer";
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(ticket: TicketSnapshot): CaptureMessage[] {
  if (Array.isArray(ticket.messages) && ticket.messages.length > 0) {
    return ticket.messages
      .map((m) => {
        const text = m.stripped_text || m.body_text || (m.body_html ? stripHtml(m.body_html) : "");
        const author = m.sender?.email || m.sender?.name || null;
        return {
          role: messageRole(m),
          author,
          content: normalizeCaptureText(text),
          at: m.created_datetime ?? null,
        };
      })
      .filter((m) => m.content.length > 0);
  }

  if (Array.isArray(ticket.comments) && ticket.comments.length > 0) {
    return ticket.comments
      .filter((c) => c.value?.trim())
      .map((c) => ({
        role: commentRole(c),
        author: c.authorEmail ?? c.authorName ?? null,
        content: stripHtml(c.value),
        at: c.createdAt ?? null,
      }));
  }

  return [];
}

/** Extracts order-context fields from ticket order data or custom fields. */
export function extractOrderFields(
  ticket: TicketSnapshot,
  orderFieldKeys: readonly string[] = DEFAULT_ORDER_FIELDS,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const orderObj = ticket.order;
  if (orderObj && typeof orderObj === "object") {
    for (const key of orderFieldKeys) {
      if (key in orderObj && orderObj[key] !== undefined && orderObj[key] !== null) {
        out[key] = orderObj[key];
      }
    }
    // Also map common alias keys if present in order object
    if (!out.order_id && orderObj.id !== undefined && orderObj.id !== null) {
      out.order_id = orderObj.id;
    }
    if (!out.order_number && orderObj.order_number !== undefined && orderObj.order_number !== null) {
      out.order_number = orderObj.order_number;
    }
  }

  // Also check ticket custom fields
  const ticketFields = ticket.fields;
  if (ticketFields && typeof ticketFields === "object") {
    for (const key of orderFieldKeys) {
      if (out[key] === undefined && key in ticketFields && ticketFields[key] !== undefined && ticketFields[key] !== null) {
        out[key] = ticketFields[key];
      }
    }
  }

  return out;
}

export interface PendingSend {
  text: string;
  type: "publicReply" | "internalNote" | string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the agent sends a reply in Gorgias. */
export function decideOnSend(input: {
  ticket: TicketSnapshot;
  draft: DraftState | null;
  draftFields?: Record<string, unknown>;
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
  if (send.type === "internalNote" && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  // Combine decision fields with any ecommerce order fields
  const orderFields = extractOrderFields(ticket, settings.orderFields);
  const baseFields: Record<string, unknown> = {
    ...orderFields,
    ...(ticket.fields ?? {}),
  };

  const configuredFields = settings.decisionFields;
  const hasDecisionFields = configuredFields.length > 0;
  const hasOrderFields = Object.keys(orderFields).length > 0;
  const includeFields = hasDecisionFields || hasOrderFields;

  const resolvedDraftFields: Record<string, unknown> = {
    ...baseFields,
    ...(input.draftFields ?? {}),
  };
  const resolvedSendFields: Record<string, unknown> = {
    ...baseFields,
    ...(send.fields ?? {}),
  };

  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(includeFields ? { fields: resolvedDraftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(includeFields ? { fields: resolvedSendFields } : {}),
  };

  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;

  // Honour require_reason: return need-reason when draft was changed and no code selected
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const requester =
    ticket.customerEmail ??
    ticket.customerName ??
    ticket.customer?.email ??
    ticket.customer?.name ??
    (ticket.customer?.firstname ? `${ticket.customer.firstname} ${ticket.customer?.lastname ?? ""}`.trim() : null);

  const metadata: Record<string, unknown> = {
    requester,
  };
  if (hasOrderFields) {
    metadata.order = orderFields;
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
    tags: [`draft:${draft.origin}`, send.type === "internalNote" ? "internal-note" : "public-reply"],
    metadata,
  };

  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the Gorgias widget sidebar. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).filter(Boolean).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the agent clicks for the chosen pack (default support). */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
