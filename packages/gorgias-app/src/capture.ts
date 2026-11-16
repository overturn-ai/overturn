import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** One message of the thread, as the Gorgias REST API returns it. */
export interface MessageSnapshot {
  id?: number | string;
  /** Public replies only; an internal note is not public. */
  public: boolean;
  fromAgent: boolean;
  senderName?: string | null;
  senderEmail?: string | null;
  createdAt?: string | null;
  /** Message body as text. Gorgias also returns HTML; the text is what the human read. */
  text: string;
}

/** What the app knows about the ticket, read through the Gorgias REST API. */
export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  customerEmail: string | null;
  customerName: string | null;
  /** Oldest first, as Gorgias returns `ticket.messages`. */
  messages: MessageSnapshot[];
  /** Custom fields the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  /** Order context (order id, status, totals) the agent answers an ecommerce question from. */
  order: Record<string, unknown>;
  tags: readonly string[];
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  /** Where this app is served: the widget data URL, the reason picker and the draft page. */
  appUrl: string;
  /** Shared secret Gorgias puts in the integration URL; links carry it back. Empty = no check. */
  widgetToken: string | null;
  agent: string;
  /** Hold a changed send until a reason is picked, instead of filing it without one. */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies. */
  captureInternalNotes: boolean;
  /** `123:coverage, 456:reserve` → custom field ids that are the decision, by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** `4509:order_id, 4510:shipping_status` → custom field ids kept as order context. */
  orderFields: Array<{ id: string; label: string }>;
  /** Texts shorter than this are never a draft, when a draft is offered by hand. */
  minDraftChars: number;
  /** When set, only tickets carrying this tag are watched; every other ticket is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: the vendor-neutral support pack, or claims. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  appUrl: "",
  widgetToken: null,
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  orderFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

function fieldList(raw: unknown): Array<{ id: string; label: string }> {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
}

/** Parses the app's settings: the manifest parameters, or the environment of a self-hosted app. */
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
    appUrl: (str("app_url") ?? DEFAULT_SETTINGS.appUrl).replace(/\/+$/, ""),
    widgetToken: str("widget_token"),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fieldList(str("decision_fields")),
    orderFields: fieldList(str("order_fields")),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag"),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/** With a scope tag configured, a ticket without it is never read at all. */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. Gorgias gives an app no handle on the reply box, so a draft is known
 * because something told us about it: the drafting agent's own recorded run (`externalId`
 * `gr:<ticket id>`, origin `recorded`), a drafting agent announcing the text it put in the composer
 * (`inserted`), or the agent pasting the text into the Overturn page the widget links to (`manual`).
 */
export type DraftOrigin = "recorded" | "inserted" | "manual";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

/** The run a drafting agent recorded with the Overturn SDK. */
export interface RecordedRun {
  id: string;
  agent: string;
  output: unknown;
  model?: string | null;
  endedAt?: string | null;
}

/**
 * The draft as the drafting agent recorded it. `at` is when the run ended, so a reply that predates
 * the draft is never mistaken for a send of it (see handler.ts).
 */
export function draftFromRun(run: RecordedRun, now = Date.now()): DraftState | null {
  if (typeof run.output !== "string" || !run.output.trim()) return null;
  const ended = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
  return {
    text: run.output,
    origin: "recorded",
    runId: run.id,
    model: run.model ?? null,
    at: Number.isFinite(ended) ? ended : now,
  };
}

/** A draft offered to the app by hand (the widget's draft page: paste what is in the reply box). */
export function draftFromHand(
  text: string,
  settings: AppSettings,
  opts: { origin?: DraftOrigin; now?: number } = {},
): DraftState | null {
  const trimmed = text.trim();
  if (trimmed.length < settings.minDraftChars) return null;
  return { text: trimmed, origin: opts.origin ?? "manual", at: opts.now ?? Date.now() };
}

function role(m: MessageSnapshot): CaptureMessage["role"] {
  if (!m.public) return "note";
  return m.fromAgent ? "agent" : "customer";
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(ticket: TicketSnapshot): CaptureMessage[] {
  const thread = ticket.messages
    .filter((m) => m.text?.trim())
    .map((m) => ({
      role: role(m),
      author: m.senderEmail ?? m.senderName ?? null,
      content: normalizeCaptureText(m.text),
      at: m.createdAt ?? null,
    }));
  const order = Object.entries(ticket.order).filter(([, v]) => v !== null && v !== undefined);
  if (order.length === 0) return thread;
  // The order the agent has open in the sidebar is part of what they answered from.
  return [
    {
      role: "system",
      author: null,
      content: `Order: ${JSON.stringify(Object.fromEntries(order))}`,
      at: null,
    },
    ...thread,
  ];
}

/** Gorgias hands message bodies back as HTML too; the text is what the human read. */
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
  /** Gorgias `message.public`: false on an internal note. */
  public: boolean;
  fields: Record<string, unknown>;
  /** The Gorgias message the app will not look at twice. */
  messageId: number | string | null;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  /** Held until a reason is picked: the body is ready, the reason is not, and the send already went. */
  | { action: "need-reason"; body: CaptureCreate; changedFields: string[] };

/**
 * What to do when a message lands in the thread. Pure: the Gorgias glue only forwards the answer.
 * Gorgias has no submit hook to block, so `need-reason` is a hold, not a wall: the capture is kept
 * until the agent picks a reason, and the send goes out either way (see handler.ts).
 */
export function decideOnSend(input: {
  ticket: TicketSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the message landed; with the draft's `at`, gives how long it sat in front of the agent. */
  now?: number;
}): SendDecision {
  const { ticket, draft, send, settings } = input;
  const sentText = normalizeCaptureText(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!send.public && !settings.captureInternalNotes) return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: normalizeCaptureText(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;

  const order = Object.fromEntries(Object.entries(ticket.order).filter(([, v]) => v != null));
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
    tags: [`draft:${draft.origin}`, send.public ? "public-reply" : "internal-note"],
    metadata: {
      customer: ticket.customerEmail ?? ticket.customerName ?? null,
      ...(Object.keys(order).length > 0 ? { order } : {}),
    },
  };
  // Gorgias cannot hold the send, so the reason is collected after it: the caller keeps this body
  // until one is picked, then posts it vouched (see handler.ts).
  if (diff.changed && settings.requireReason && !reasonCode) {
    return {
      action: "need-reason",
      body: { ...body, reason: null, reasonCode: null },
      changedFields: diff.changedFields,
    };
  }
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/**
 * Short status line for the sidebar. Gorgias shows an app no reply box to watch, so a recorded run
 * and an announced insertion are the same story from here: the drafting agent's text is in the
 * reply box. `manual` is the agent's own text, offered by hand.
 */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).length;
  const from = { recorded: "inserted", inserted: "inserted", manual: "marked by you" }[d.origin];
  return `Draft ${from} · ${words} words`;
}

/** The chips the agent clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
