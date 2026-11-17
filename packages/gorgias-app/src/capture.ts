import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the widget knows about the ticket, read through the Gorgias REST API. */
export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  customerName: string | null;
  customerEmail: string | null;
  /** Oldest first, as the ticket carries them. */
  messages: Array<{
    id: number | string;
    /** HTML or plain text, as Gorgias returns message bodies. */
    body: string;
    /** Customer message, agent reply, or an internal note. */
    kind: "customer" | "agent" | "note" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    createdAt?: string | null;
  }>;
  /** The ticket's order, when it has one (the ecommerce context this surface cares about). */
  order: {
    id?: number | string;
    number?: string | number;
    total?: number | string;
    currency?: string;
    status?: string;
    fulfillmentStatus?: string;
  } | null;
  /** Ticket tags, by name, for the scope_tag setting. */
  tags: string[];
  /** Ticket custom fields by name. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold a changed reply's capture until the agent picks a reason (on by default). */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies. */
  captureInternalNotes: boolean;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the widget watches only tickets carrying this tag; every other ticket is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: the support pack by default on this surface. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

/** Parses the app's settings (strings and booleans from the app configuration). */
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
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/**
 * Whether the widget should watch this ticket at all. With no scope tag every ticket is
 * watched, but nothing is read beyond the panel until a draft exists (see main.ts). With a
 * scope tag, tickets without it are never read at all.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. A Gorgias widget cannot see the reply box, so a draft reaches
 * the panel two honest ways: a drafting agent recorded its run with the SDK (found by
 * ticket id), or the agent marks/pastes the draft in the panel by hand. There is no third
 * source and the panel never pretends otherwise.
 */
export type DraftOrigin = "manual" | "recorded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

function role(m: TicketSnapshot["messages"][number]): CaptureMessage["role"] {
  if (m.kind === "note") return "note";
  return m.kind === "agent" ? "agent" : "customer";
}

/** The thread the agent saw, oldest first, as capture context. The message the agent just
 * sent is the decision's output, not what they saw when deciding, so when its id is known
 * it is left out here (it still rides on the payload as `sent`). */
export function contextFrom(ticket: TicketSnapshot, excludeId?: number | string): CaptureMessage[] {
  return ticket.messages
    .filter((m) => m.body?.trim() && m.id !== excludeId)
    .map((m) => ({
      role: role(m),
      author: m.authorEmail ?? m.authorName ?? null,
      content: stripHtml(m.body),
      at: m.createdAt ?? null,
    }));
}

/** Gorgias hands message bodies back as HTML; the case wants the text the human read. */
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

/**
 * The order context of the ticket, as answer fields. Ecommerce teams are this surface's
 * first users: the order is part of what the expert decided about, so it rides on both
 * answers and a change to it between draft and send is scored exactly, like any other
 * decision field. One fixed key list - the fields the scorecard knows how to read.
 */
export const ORDER_FIELD_KEYS = [
  "order_id",
  "order_number",
  "order_total",
  "order_currency",
  "order_status",
  "fulfillment_status",
] as const;

export function orderFieldsFrom(ticket: TicketSnapshot): Record<string, unknown> {
  const o = ticket.order;
  if (!o) return {};
  const out: Record<string, unknown> = {};
  const put = (key: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  };
  put("order_id", o.id);
  put("order_number", o.number);
  put("order_total", o.total);
  put("order_currency", o.currency);
  put("order_status", o.status);
  put("fulfillment_status", o.fulfillmentStatus);
  return out;
}

/**
 * The ticket's order, as Gorgias actually serves it. A ticket carries no order object of
 * its own; the customer's ecommerce integrations do (Shopify, BigCommerce, ...), each with
 * an `orders` list. The newest order across integrations is the one the ticket is about.
 * Only the fields a support decision turns on are kept; no addresses, no payment details.
 */
export function latestOrderFrom(integrations: unknown): TicketSnapshot["order"] {
  if (!integrations || typeof integrations !== "object") return null;
  const str = (v: unknown): string | null =>
    typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;
  const rec = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  const found: Array<{ at: string; order: Exclude<TicketSnapshot["order"], null> }> = [];
  for (const data of Object.values(integrations as Record<string, unknown>)) {
    const list = rec(data).orders;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const o = rec(raw);
      const id = o.id;
      if ((typeof id !== "string" && typeof id !== "number") || id === "") continue;
      const totalRaw = o.total_price ?? o.total;
      const shopMoney = rec(rec(o.total_price_set).shop_money);
      found.push({
        at: str(o.created_at) ?? "",
        order: {
          id,
          number: str(o.name) ?? id,
          total: typeof totalRaw === "string" || typeof totalRaw === "number" ? totalRaw : undefined,
          currency: str(o.currency) ?? str(shopMoney.currency_code) ?? undefined,
          status: str(o.financial_status) ?? str(o.status) ?? undefined,
          fulfillmentStatus: str(o.fulfillment_status) ?? undefined,
        },
      });
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => b.at.localeCompare(a.at));
  return found[0]?.order ?? null;
}

export interface PendingSend {
  /** The ticket message this send is, so the decision can keep it out of the context. */
  id?: number | string;
  text: string;
  type: "publicReply" | "internalNote" | string;
  fields: Record<string, unknown>;
  /** Who sent it, when the message names them. */
  actor?: string | null;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the agent sends. Pure: the Gorgias glue only forwards the answer. */
export function decideOnSend(input: {
  ticket: TicketSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code (support pack), required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the send happened; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { ticket, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "internalNote" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const orderFields = orderFieldsFrom(ticket);
  const hasFields = Object.keys(orderFields).length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: { ...orderFields, ...input.draftFields } } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: { ...orderFields, ...send.fields } } : {}),
  };
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
    context: contextFrom(ticket, send.id),
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
      requester: ticket.customerEmail ?? ticket.customerName ?? null,
      ...(orderFields.order_number !== undefined ? { order_number: orderFields.order_number } : {}),
    },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/**
 * The send, as the widget can observe it: a sent reply appears on the ticket as a new
 * agent message. Given the message ids already seen and the ticket's current messages,
 * returns the first agent message that was not there before, or null. Internal notes are
 * only a send when the app is configured to capture them.
 */
export function sentFromMessages(
  seenIds: ReadonlySet<number | string>,
  messages: TicketSnapshot["messages"],
  settings: AppSettings,
): PendingSend | null {
  for (const m of messages) {
    if (seenIds.has(m.id)) continue;
    if (m.kind === "agent")
      return {
        id: m.id,
        text: m.body,
        type: "publicReply",
        fields: {},
        actor: m.authorEmail ?? m.authorName ?? null,
      };
    if (m.kind === "note" && settings.captureInternalNotes)
      return {
        id: m.id,
        text: m.body,
        type: "internalNote",
        fields: {},
        actor: m.authorEmail ?? m.authorName ?? null,
      };
  }
  return null;
}

/**
 * A changed send that is waiting for its reason. The widget cannot stop a Gorgias send,
 * so `require_reason` holds the capture instead: the send is kept here, the panel asks
 * for the one click, and `resolve` re-runs the decision with the picked code.
 */
export interface PendingCapture {
  hold(decision: SendDecision, retry: () => SendDecision): boolean;
  pending(): boolean;
  resolve(): SendDecision | null;
  clear(): void;
}

export function createPendingCapture(): PendingCapture {
  let retry: (() => SendDecision) | null = null;
  return {
    hold(decision, fn) {
      if (decision.action !== "need-reason") return false;
      retry = fn;
      return true;
    },
    pending: () => retry !== null,
    resolve() {
      if (!retry) return null;
      const fn = retry;
      retry = null;
      return fn();
    },
    clear() {
      retry = null;
    },
  };
}

/** Short status line for the sidebar. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).length;
  const from = {
    manual: "marked by you",
    recorded: "recorded by your agent",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the agent clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
