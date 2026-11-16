import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/**
 * One message of the Gorgias thread, as the REST API returns it.
 * Gorgias ships both an HTML body and `body_text`; the case wants the words the customer read,
 * so only `bodyText` is read and the HTML twin is ignored.
 */
export interface GorgiasMessage {
  id?: number | string;
  bodyText: string;
  /** True when the agent wrote it; false for the customer. */
  fromAgent: boolean;
  /** A private note to the team, not a reply to the customer. */
  isNote?: boolean;
  authorEmail?: string | null;
  authorName?: string | null;
  /** Gorgias writes `created_datetime` without a timezone offset; the value is UTC. */
  createdAt?: string | null;
}

/** An order of the customer, as the shop integration reported it. */
export interface GorgiasOrder {
  id: number | string;
  /** The integration the order came from, e.g. "shopify". */
  provider: string;
  total?: string | number | null;
  currency?: string | null;
  itemCount?: number | null;
  createdAt?: string | null;
}

/** What the app knows about the ticket, read through the Gorgias REST API. */
export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  customerEmail: string | null;
  customerName: string | null;
  /** The agent the ticket is assigned to, when the ticket says. */
  assigneeEmail: string | null;
  /** Oldest first, as `GET /api/tickets/{id}/messages` returns them. */
  messages: GorgiasMessage[];
  tags: string[];
  orders: GorgiasOrder[];
  /** Decision fields the admin chose, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold a changed reply's capture in the widget until the agent picks a reason. */
  requireReason: boolean;
  /** Also capture internal notes, not only replies to the customer. */
  captureInternalNotes: boolean;
  /** `custom_field_123:coverage, custom_field_9:reserve` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, only tickets carrying this tag are watched; every other ticket is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: the claims pack or the vendor-neutral support pack. */
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

/** Parses the app's settings (strings and booleans from the widget configuration). */
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
  };
}

/**
 * Whether the app should watch this ticket at all. With no scope tag every ticket is watched.
 * With a scope tag, tickets without it are never read, not even the thread.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from.
 *
 * Gorgias has no composer API: the REST API lists messages after they were sent, and there is
 * no endpoint for the unsent reply box. So the draft is the run a drafting agent recorded with
 * the Overturn SDK for this ticket (`externalId: "gr:<ticket id>"`). That run is the evidence
 * an assist wrote the draft, and it carries the text and the moment it was written. The agent
 * can also mark the newest agent message as the draft by hand.
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  /** Unix seconds, the unit the runs endpoint uses. */
  at: number;
}

/**
 * Gorgias writes timestamps without an offset (`2020-02-01T19:12:32.432197`); they are UTC.
 * The capture contract wants an ISO datetime with an offset, so the offset is put back here
 * rather than shipping a string the API would reject.
 */
export function isoAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = value.trim();
  if (!raw) return null;
  const withOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const parsed = Date.parse(withOffset);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Epoch seconds from a Gorgias timestamp, or null when it cannot be read. */
export function epochAt(value: string | null | undefined): number | null {
  const iso = isoAt(value);
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(ticket: TicketSnapshot): CaptureMessage[] {
  return ticket.messages
    .filter((m) => m.bodyText?.trim())
    .map((m) => ({
      role: m.isNote ? "note" : m.fromAgent ? "agent" : "customer",
      author: m.authorEmail ?? m.authorName ?? null,
      content: normalizeCaptureText(m.bodyText),
      at: isoAt(m.createdAt),
    }));
}

/**
 * The order the ticket is about, when the ticket carries one.
 *
 * Gorgias keeps shop orders under the customer, so the newest order is the one the reply is
 * about. It rides along in `metadata.order`: an e-commerce team's decision is about the order,
 * not about the prose.
 */
export function orderContext(ticket: TicketSnapshot): Record<string, unknown> | null {
  const order = ticket.orders[ticket.orders.length - 1];
  if (!order) return null;
  const context: Record<string, unknown> = { id: order.id, provider: order.provider };
  if (order.total !== undefined && order.total !== null) context.total = order.total;
  if (order.currency !== undefined && order.currency !== null) context.currency = order.currency;
  if (order.itemCount !== undefined && order.itemCount !== null) context.item_count = order.itemCount;
  if (order.createdAt) context.created_at = isoAt(order.createdAt);
  return context;
}

/** The reply the agent sent, as the capture sees it. */
export interface PendingSend {
  text: string;
  /** Unix seconds. */
  at: number | null;
  isNote: boolean;
}

/**
 * The newest agent reply written after the draft was recorded.
 *
 * Gorgias gives an app no submit hook, so the reply is found in the thread after the fact: the
 * latest agent message that is newer than the draft. An older agent message is not the reply.
 */
export function latestAgentSend(
  ticket: TicketSnapshot,
  draft: DraftState | null,
  now: number = Math.floor(Date.now() / 1000),
): PendingSend | null {
  let best: PendingSend | null = null;
  for (const message of ticket.messages) {
    if (!message.fromAgent) continue;
    const text = message.bodyText?.trim();
    if (!text) continue;
    const at = epochAt(message.createdAt);
    if (draft && at !== null && at < draft.at) continue;
    if (at !== null && at > now + 60) continue;
    if (!best || (at ?? 0) >= (best.at ?? 0)) {
      best = { text, at, isNote: message.isNote === true };
    }
  }
  return best;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "note" | "empty" | "no-send" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | {
      action: "need-reason";
      changedFields: string[];
      /**
       * The capture, ready but without a reason code. Gorgias gives an app no submit hook, so
       * the capture waits for the reason the agent clicks in the widget and is sent then.
       */
      body: CaptureCreate;
    };

/**
 * What to do with the reply the agent sent. Pure: the HTTP glue only forwards the answer.
 *
 * Gorgias has no hook that can veto a send, so `need-reason` does not stop Gorgias's send
 * button. It stops the *capture*: the widget refuses to record a changed reply until a reason
 * chip is clicked, so nothing unexplained reaches the suite. The send itself is never blocked.
 */
export function decideOnSend(input: {
  ticket: TicketSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend | null;
  /** The decision fields of the reply, when the admin configured any. */
  sendFields?: Record<string, unknown>;
  /** The picked reason code (support pack), required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the reply was sent; with the draft's `at`, gives how long it sat in front of the agent. */
  now?: number;
}): SendDecision {
  const { ticket, draft, send, settings } = input;
  if (!draft) return { action: "skip", why: "no-draft" };
  if (!send) return { action: "skip", why: "no-send" };
  const sentText = normalizeCaptureText(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.isNote && !settings.captureInternalNotes) return { action: "skip", why: "note" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: normalizeCaptureText(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: input.sendFields ?? {} } : {}),
  };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;

  const secondsToSend = Math.max(0, Math.round((input.now ?? send.at ?? draft.at) - draft.at));
  const metadata: Record<string, unknown> = {
    requester: ticket.customerEmail ?? ticket.customerName ?? null,
  };
  const order = orderContext(ticket);
  if (order) metadata.order = order;

  const body: CaptureCreate = {
    source: "gorgias",
    externalId: `gr:${ticket.id}`,
    agent: settings.agent,
    actor: input.actor ?? ticket.assigneeEmail ?? null,
    subject: ticket.subject,
    context: contextFrom(ticket),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend,
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: ticket.url,
    tags: [`draft:${draft.origin}`, send.isNote ? "internal-note" : "public-reply"],
    metadata,
  };
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields, body };
  }
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** What the capture card shows after a capture went through. */
export interface LastResult {
  kind: string;
  changed: boolean;
  dedup: boolean;
}

/**
 * The status line the sidebar shows.
 *
 * A Gorgias draft is the run an assist recorded, so the draft landed in the reply box: the
 * line reads `Draft inserted · N words`, the same wording the other adapters use.
 */
export function statusLine(draft: DraftState | null, lastResult: LastResult | null): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!draft) return "Waiting for a draft";
  const words = draft.text.trim().split(/\s+/).filter(Boolean).length;
  return `Draft inserted · ${words} words`;
}

/** The chips the agent clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
