import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the app knows about the ticket, read from the Gorgias ticket payload. */
export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  /** The ticket's customer. */
  customerEmail: string | null;
  customerName: string | null;
  /** Oldest first, as the Gorgias API returns `ticket.messages`. */
  messages: Array<{
    id?: number | string;
    /** Plain-text body when Gorgias has one; the HTML body otherwise. */
    bodyText: string | null;
    bodyHtml: string | null;
    /** Gorgias channel: "email", "chat", "internal-note", ... */
    channel: string;
    authorName?: string | null;
    authorEmail?: string | null;
    /** True when the author is an agent, false when it is the customer. */
    fromAgent?: boolean;
    createdAt?: string | null;
  }>;
  /** Ticket fields the admin chose as decision fields, by label (order fields are the usual ones here). */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Hold the capture until the agent picks a reason when the reply was changed (claims pack default). */
  requireReason: boolean;
  /** Also capture internal notes, not only sent replies. */
  captureInternalNotes: boolean;
  /** `order_status:order_status, refund_amount:refund` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the app watches only tickets carrying this tag; every other ticket is never read. */
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

/** Parses the app's configuration (strings and booleans from the host server's config). */
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
 * Whether the app should watch this ticket at all. With no scope tag every ticket is
 * watched, but nothing is read beyond the ticket until a draft is recorded (see main.ts).
 * With a scope tag, tickets without it are never read.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from, in the words the capture contract scores by (the shared
 * draftOriginSchema): "ai" when an assist produced it — the drafting integration said so,
 * or a run the drafting agent recorded with the SDK — "manual" when the expert marked the
 * text as the draft by hand, "unknown" when nobody said. Gorgias gives a third-party app
 * no view into the reply box, so a draft is only ever recorded by someone who knows where
 * it came from, never guessed.
 */
export type DraftOrigin = "ai" | "manual" | "recorded" | "unknown";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

/**
 * The `draft:*` tag the payload carries for an origin. A recorded run counts as "ai" (the
 * shared schema: an assist inserted it, or an SDK run recorded it). Unknown carries no tag
 * at all — the scorecard derives "unknown" from the absence, and guessing an origin we
 * were not told is worse than unknown.
 */
export function draftTag(origin: DraftOrigin): string | null {
  if (origin === "ai" || origin === "recorded") return "draft:ai";
  if (origin === "manual") return "draft:manual";
  return null;
}

/**
 * What the expert sent: the newest agent message on the ticket that is not an internal
 * note. Null while no reply has gone out. Gorgias fires the HTTP integration on
 * ticket-message-created, so this is the message that just landed.
 */
export function findSentMessage(
  ticket: TicketSnapshot,
): { text: string; messageId?: number | string; authorEmail: string | null } | null {
  for (let i = ticket.messages.length - 1; i >= 0; i--) {
    const m = ticket.messages[i]!;
    if (!m.fromAgent || m.channel === "internal-note") continue;
    const text = messageText(m);
    if (text) return { text, messageId: m.id, authorEmail: m.authorEmail ?? null };
  }
  return null;
}

function messageText(m: TicketSnapshot["messages"][number]): string {
  if (m.bodyText?.trim()) return normalizeCaptureText(m.bodyText);
  return m.bodyHtml ? stripHtml(m.bodyHtml) : "";
}

function role(m: TicketSnapshot["messages"][number]): CaptureMessage["role"] {
  if (m.channel === "internal-note") return "note";
  return m.fromAgent ? "agent" : "customer";
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(ticket: TicketSnapshot): CaptureMessage[] {
  return ticket.messages
    .map((m) => ({ m, text: messageText(m) }))
    .filter((x) => x.text)
    .map((x) => ({
      role: role(x.m),
      author: x.m.authorEmail ?? x.m.authorName ?? null,
      content: x.text,
      at: x.m.createdAt ?? null,
    }));
}

/** Gorgias hands message bodies back as HTML when there is no text part; the case wants the text the human read. */
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
  type: "reply" | "internal-note" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do with the expert's reply. Pure: the integration glue only forwards the answer. */
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
  /** When the reply was sent; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { ticket, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "internal-note" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
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

  const tag = draftTag(draft.origin);
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
    tags: [...(tag ? [tag] : []), send.type === "internal-note" ? "internal-note" : "public-reply"],
    metadata: { customer: ticket.customerEmail ?? ticket.customerName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the sidebar widget. */
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
    ai: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    unknown: null,
  }[d.origin];
  return from ? `Draft ${from} · ${words} words` : `Draft · ${words} words`;
}

/** The options the agent picks from, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
