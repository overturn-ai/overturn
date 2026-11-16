import type { CaptureAnswer, CaptureCreate, CaptureMessage, CaptureResult } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

export interface GorgiasOrderContext {
  orderId?: string | null;
  orderNumber?: string | null;
  orderStatus?: string | null;
  fulfillmentStatus?: string | null;
  refundAmount?: number | string | null;
  currency?: string | null;
}

export interface GorgiasMessageItem {
  id?: number | string;
  bodyHtml: string;
  bodyText?: string | null;
  fromAgent: boolean;
  isInternalNote?: boolean;
  senderEmail?: string | null;
  senderName?: string | null;
  createdAt?: string | null;
}

export interface GorgiasTicketSnapshot {
  id: number | string;
  subject: string | null;
  customerEmail: string | null;
  customerName: string | null;
  /** Oldest first. */
  messages: GorgiasMessageItem[];
  /** Custom or order-context decision fields, by label. */
  fields: Record<string, unknown>;
  /** Ecommerce order context attached to the ticket (Shopify, WooCommerce, etc.). */
  order?: GorgiasOrderContext | null;
  tags: string[];
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  apiKey: string | null;
  agent: string;
  requireReason: boolean;
  captureInternalNotes: boolean;
  decisionFields: Array<{ id: string; label: string }>;
  minDraftChars: number;
  scopeTag: string | null;
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  apiKey: null,
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
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
  const fields = (str("decision_fields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id ?? s, label: label || id || s };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    apiKey: str("overturn_api_key"),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

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
  onComposer(text: string, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const windowMs = opts.typingWindowMs ?? 1500;
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
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > windowMs);
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

function messageRole(m: GorgiasMessageItem): CaptureMessage["role"] {
  if (m.isInternalNote) return "note";
  return m.fromAgent ? "agent" : "customer";
}

export function contextFrom(ticket: GorgiasTicketSnapshot): CaptureMessage[] {
  return ticket.messages
    .filter((m) => (m.bodyHtml || m.bodyText || "").trim())
    .map((m) => ({
      role: messageRole(m),
      author: m.senderEmail ?? m.senderName ?? null,
      content: m.bodyText?.trim() ? normalizeCaptureText(m.bodyText) : stripHtml(m.bodyHtml),
      at: m.createdAt ?? null,
    }));
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

export interface PendingSend {
  text: string;
  type: "publicReply" | "internalNote" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

export function decideOnSend(input: {
  ticket: GorgiasTicketSnapshot;
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
  if (send.type === "internalNote" && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: send.fields } : {}),
  };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;

  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const orderMeta: Record<string, unknown> = {};
  if (ticket.order) {
    if (ticket.order.orderId) orderMeta.orderId = ticket.order.orderId;
    if (ticket.order.orderNumber) orderMeta.orderNumber = ticket.order.orderNumber;
    if (ticket.order.orderStatus) orderMeta.orderStatus = ticket.order.orderStatus;
    if (ticket.order.fulfillmentStatus) orderMeta.fulfillmentStatus = ticket.order.fulfillmentStatus;
    if (ticket.order.refundAmount !== undefined && ticket.order.refundAmount !== null) {
      orderMeta.refundAmount = ticket.order.refundAmount;
    }
    if (ticket.order.currency) orderMeta.currency = ticket.order.currency;
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
    metadata: {
      customer: ticket.customerEmail ?? ticket.customerName ?? null,
      ...orderMeta,
    },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

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
  return `Draft inserted · ${words} words`;
}

export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type CapturePostOutcome =
  | { ok: true; result: CaptureResult }
  | { ok: false; status: number | "network" };

export async function postCapture(
  fetchFn: FetchLike,
  settings: AppSettings,
  body: CaptureCreate,
  log: (msg: string, err?: unknown) => void = (msg, err) => console.warn(msg, err),
): Promise<CapturePostOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
  try {
    const res = await fetchFn(`${settings.baseUrl}/v1/capture`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log(`[overturn-gorgias] capture failed with HTTP ${res.status}`);
      return { ok: false, status: res.status };
    }
    const result = (await res.json()) as CaptureResult;
    return { ok: true, result };
  } catch (err) {
    log("[overturn-gorgias] capture failed due to network error", err);
    return { ok: false, status: "network" };
  }
}
