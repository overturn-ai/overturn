import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** A single message in the ticket thread, as Gorgias returns or as formatted by the widget. */
export interface GorgiasMessageSnapshot {
  id?: number | string;
  body_text?: string | null;
  body_html?: string | null;
  bodyText?: string | null;
  bodyHtml?: string | null;
  body?: string | null;
  value?: string | null;
  channel?: string | null;
  type?: string | null;
  from_agent?: boolean;
  fromAgent?: boolean;
  isAgent?: boolean;
  public?: boolean;
  sender?: {
    id?: number | string;
    email?: string | null;
    name?: string | null;
  } | null;
  authorEmail?: string | null;
  authorName?: string | null;
  sent_datetime?: string | null;
  sentDatetime?: string | null;
  created_datetime?: string | null;
  createdDatetime?: string | null;
  createdAt?: string | null;
}

/** What the app knows about the Gorgias ticket. */
export interface GorgiasTicketSnapshot {
  id: number | string;
  subject: string | null;
  customer?: {
    id?: number | string;
    email?: string | null;
    name?: string | null;
    firstname?: string | null;
    lastname?: string | null;
  } | null;
  customerEmail?: string | null;
  customerName?: string | null;
  requesterEmail?: string | null;
  requesterName?: string | null;
  /** Messages in the conversation, oldest first. */
  messages?: GorgiasMessageSnapshot[];
  /** Alias for messages/comments. */
  comments?: GorgiasMessageSnapshot[];
  /** Custom / ticket fields by label or key. */
  fields?: Record<string, unknown>;
  custom_fields?: Record<string, unknown>;
  /** Ecommerce order context (e.g. Shopify / BigCommerce order data). */
  order?: Record<string, unknown> | null;
  url: string | null;
}

export type TicketSnapshot = GorgiasTicketSnapshot;

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Block the send until the agent picks a reason when the reply was changed (default: true). */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies (default: false). */
  captureInternalNotes: boolean;
  /** Custom/order fields that are the decision, as `id:label` pairs (e.g. `order_status:status, refund_amount:refund`). */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the app watches only tickets carrying this tag; every other ticket is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: the support pack (default) or claims pack. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

/** Parses the app's metadata settings (strings and booleans). */
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
  const num = (k: string): number | null => {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim()) {
      const n = Number(v.trim());
      if (Number.isFinite(n)) return n;
    }
    return null;
  };

  const rawFields = str("decision_fields") ?? str("decisionFields") ?? "";
  const fields = rawFields
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });

  const min = num("min_draft_chars") ?? num("minDraftChars");
  const baseUrlRaw = str("overturn_base_url") ?? str("baseUrl") ?? DEFAULT_SETTINGS.baseUrl;

  return {
    baseUrl: baseUrlRaw.replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", bool("requireReason", DEFAULT_SETTINGS.requireReason)),
    captureInternalNotes: bool(
      "capture_internal_notes",
      bool("captureInternalNotes", DEFAULT_SETTINGS.captureInternalNotes),
    ),
    decisionFields: fields,
    minDraftChars: min !== null && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag") ?? str("scopeTag"),
    reasonPack: reasonPackFrom(str("reason_pack") ?? str("reasonPack")),
  };
}

/** Whether the app should watch this ticket at all. */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a macro,
 * a paste), not typed, and it is the draft. The agent can also mark the current text as the
 * draft by hand, and a drafting agent that recorded its run with the SDK is found by ticket id.
 */
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

function role(m: GorgiasMessageSnapshot): CaptureMessage["role"] {
  if (m.channel === "internal-note" || m.type === "internalNote" || m.public === false) {
    return "note";
  }
  const isAgent = m.from_agent ?? m.fromAgent ?? m.isAgent;
  return isAgent ? "agent" : "customer";
}

function messageContent(m: GorgiasMessageSnapshot): string {
  const text = m.body_text ?? m.bodyText;
  if (typeof text === "string" && text.trim()) {
    return normalizeCaptureText(text);
  }
  const html = m.body_html ?? m.bodyHtml ?? m.body ?? m.value;
  if (typeof html === "string" && html.trim()) {
    return stripHtml(html);
  }
  return "";
}

function messageAuthor(m: GorgiasMessageSnapshot): string | null {
  return m.sender?.email ?? m.sender?.name ?? m.authorEmail ?? m.authorName ?? null;
}

function messageAt(m: GorgiasMessageSnapshot): string | null {
  return (
    m.sent_datetime ??
    m.sentDatetime ??
    m.created_datetime ??
    m.createdDatetime ??
    m.createdAt ??
    null
  );
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(ticket: GorgiasTicketSnapshot): CaptureMessage[] {
  const list = ticket.messages ?? ticket.comments ?? [];
  return list
    .map((m) => ({
      role: role(m),
      author: messageAuthor(m),
      content: messageContent(m),
      at: messageAt(m),
    }))
    .filter((m) => m.content.length > 0);
}

/** Gorgias may hand bodies back as HTML; the case wants the text the human read. */
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

/** Extracts decision fields from ticket fields, custom fields, or order context. */
export function extractDecisionFields(
  source: {
    fields?: Record<string, unknown>;
    custom_fields?: Record<string, unknown>;
    order?: Record<string, unknown> | null;
  },
  decisionFields: Array<{ id: string; label: string }>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const { id, label } of decisionFields) {
    const key = label || id;
    let val: unknown = undefined;
    if (source.fields && id in source.fields) {
      val = source.fields[id];
    } else if (source.fields && label in source.fields) {
      val = source.fields[label];
    } else if (source.custom_fields && id in source.custom_fields) {
      val = source.custom_fields[id];
    } else if (source.custom_fields && label in source.custom_fields) {
      val = source.custom_fields[label];
    } else if (source.order && id in source.order) {
      val = source.order[id];
    } else if (source.order && label in source.order) {
      val = source.order[label];
    } else if (source.order && id.startsWith("order.") && id.slice(6) in source.order) {
      val = source.order[id.slice(6)];
    }
    result[key] = val !== undefined ? val : null;
  }
  return result;
}

export interface PendingSend {
  text: string;
  type?: "publicReply" | "internalNote" | "public" | "internal-note" | string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the reviewer sends the reply. Pure: the Gorgias glue forwards the answer. */
export function decideOnSend(input: {
  ticket: GorgiasTicketSnapshot;
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

  const sendType = send.type ?? "publicReply";
  const isInternal =
    sendType === "internalNote" || sendType === "internal-note" || sendType === "note";
  if (isInternal && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasConfigured = settings.decisionFields.length > 0;
  const rawDraftFields = input.draftFields ?? {};
  const rawSendFields = send.fields ?? ticket.fields ?? ticket.custom_fields ?? {};
  const hasExplicit = Object.keys(rawDraftFields).length > 0 || Object.keys(rawSendFields).length > 0;
  const hasFields = hasConfigured || hasExplicit;

  const resolvedDraftFields = hasConfigured
    ? extractDecisionFields(
        { fields: rawDraftFields, custom_fields: ticket.custom_fields, order: ticket.order },
        settings.decisionFields,
      )
    : rawDraftFields;
  const resolvedSendFields = hasConfigured
    ? extractDecisionFields(
        { fields: rawSendFields, custom_fields: ticket.custom_fields, order: ticket.order },
        settings.decisionFields,
      )
    : rawSendFields;

  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: resolvedDraftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: resolvedSendFields } : {}),
  };

  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const customer =
    ticket.customer?.email ??
    ticket.customer?.name ??
    ticket.customerEmail ??
    ticket.customerName ??
    ticket.requesterEmail ??
    ticket.requesterName ??
    null;

  const url =
    ticket.url ??
    (ticket.id ? `https://gorgias.com/app/tickets/${ticket.id}` : null);

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
    url,
    tags: [
      `draft:${draft.origin}`,
      isInternal ? "internal-note" : "public-reply",
    ],
    metadata: {
      requester: customer,
      customer,
      ...(ticket.order ? { order: ticket.order } : {}),
    },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the Gorgias sidebar. */
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

/** The chips the reviewer clicks, for the installed pack (defaults to support pack). */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
