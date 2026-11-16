import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** An author as Intercom returns it on a conversation or part. */
export interface IntercomAuthor {
  type?: string | null;
  id?: string | null;
  name?: string | null;
  email?: string | null;
}

/** One message in the conversation thread. */
export interface IntercomConversationPart {
  id?: string | number | null;
  part_type?: string | null;
  body?: string | null;
  created_at?: number | string | null;
  author?: IntercomAuthor | null;
}

/** The slice of the Intercom conversation model this app reads. Extra fields are ignored. */
export interface IntercomConversation {
  id: string | number;
  title?: string | null;
  source?: {
    type?: string | null;
    subject?: string | null;
    body?: string | null;
    author?: IntercomAuthor | null;
    created_at?: number | string | null;
  } | null;
  /** The REST API wraps parts in `{ conversation_parts: [...] }`; accept the bare array too. */
  conversation_parts?:
    | { conversation_parts?: IntercomConversationPart[] | null }
    | IntercomConversationPart[]
    | null;
  links?: { conversation?: string | null } | null;
  custom_attributes?: Record<string, unknown> | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Block the capture action until a reason is picked when the reply was changed. */
  requireReason: boolean;
  /** Which quick-pick reasons the teammate sees. Support is the Intercom default. */
  reasonPack: ReasonPack;
  /** Conversation fields that are part of the decision, as `key` or `key:Label` pairs. */
  decisionFields: Array<{ key: string; label: string }>;
  /** Composer text shorter than this never counts as a draft (a one-line hello is not a draft). */
  minDraftChars: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  reasonPack: "support",
  decisionFields: [],
  minDraftChars: 80,
};

/** Parses the environment/settings object used by the Canvas Kit server. */
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
      const [key, label] = s.split(":").map((x) => x.trim());
      return { key: key!, label: label || key! };
    });
  const min = Number(str("min_draft_chars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    reasonPack: reasonPackFrom(str("reason_pack")),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
  };
}

/**
 * Where the draft came from. Only a signal the caller actually sent is used: an assist flag,
 * an explicit origin, or the author type of the draft. The text itself is never inspected.
 */
export type DraftOrigin = "ai" | "manual" | "unknown";

export interface DraftOriginSignals {
  origin?: unknown;
  assist?: unknown;
  authorType?: unknown;
}

function normalizedOrigin(value: unknown): DraftOrigin | null {
  if (typeof value === "boolean") return value ? "ai" : null;
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "ai":
    case "draft:ai":
    case "assist":
    case "assisted":
    case "fin":
    case "bot":
    case "automated":
    case "generated":
      return "ai";
    case "manual":
    case "draft:manual":
    case "human":
    case "typed":
    case "admin":
    case "teammate":
      return "manual";
    case "unknown":
    case "draft:unknown":
      return "unknown";
    default:
      return null;
  }
}

/**
 * The origin tag we can honestly attach. If nothing told us who wrote the draft, it is
 * `unknown`; guessing between Fin and a human would poison the scorecard.
 */
export function draftOriginFrom(signals: DraftOriginSignals = {}): DraftOrigin {
  const explicit = normalizedOrigin(signals.origin);
  if (explicit) return explicit;
  const assist = normalizedOrigin(signals.assist);
  if (assist === "ai") return "ai";
  const author = normalizedOrigin(signals.authorType);
  if (author === "ai" || author === "manual") return author;
  return "unknown";
}

export const DRAFT_TAGS: Record<DraftOrigin, string> = {
  ai: "draft:ai",
  manual: "draft:manual",
  unknown: "draft:unknown",
};

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  at: number;
  runId?: string;
  model?: string | null;
}

export interface DraftDetector {
  /** Feed every composer value; returns the draft the first time a reply-sized text appears. */
  onComposer(text: string, signals?: DraftOriginSignals, now?: number): DraftState | null;
  /** Mark the current text as the draft explicitly (the teammate says this is what they are reviewing). */
  mark(text: string, signals?: DraftOriginSignals, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  const create = (text: string, signals: DraftOriginSignals | undefined, at: number): DraftState => ({
    text,
    origin: draftOriginFrom(signals),
    at,
  });
  return {
    onComposer(text, signals, now = Date.now()) {
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
        draft = create(text, signals, now);
        return draft;
      }
      return null;
    },
    mark(text, signals, now = Date.now()) {
      if (!text.trim()) return null;
      draft = create(text, signals, now);
      return draft;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
  };
}

function roleFor(part: IntercomConversationPart): CaptureMessage["role"] {
  const partType = part.part_type?.trim().toLowerCase();
  if (partType === "note" || partType === "internal_note") return "note";
  if (partType === "assignment" || partType === "close" || partType === "open") return "system";
  const author = part.author?.type?.trim().toLowerCase();
  if (author === "bot" || author === "fin" || author === "admin" || author === "teammate") return "agent";
  if (author === "user" || author === "lead" || author === "contact") return "customer";
  return "system";
}

function authorLabel(author: IntercomAuthor | null | undefined): string | null {
  return author?.email ?? author?.name ?? null;
}

function isoTime(value: number | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric > 1e12 ? numeric : numeric * 1000)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Intercom sends message bodies as HTML; the capture context wants the text the human read. */
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
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code))),
  );
}

function partsOf(conversation: IntercomConversation): IntercomConversationPart[] {
  const parts = conversation.conversation_parts;
  if (!parts) return [];
  if (Array.isArray(parts)) return parts;
  return parts.conversation_parts ?? [];
}

/** The thread the teammate saw, oldest first, as capture context. */
export function contextFrom(conversation: IntercomConversation): CaptureMessage[] {
  const messages: CaptureMessage[] = [];
  const source = conversation.source;
  if (source?.body?.trim()) {
    messages.push({
      role: roleFor({ body: source.body, author: source.author, part_type: "comment" }),
      author: authorLabel(source.author),
      content: stripHtml(source.body),
      at: isoTime(source.created_at),
    });
  }
  for (const part of partsOf(conversation)) {
    if (!part.body?.trim()) continue;
    messages.push({
      role: roleFor(part),
      author: authorLabel(part.author),
      content: stripHtml(part.body),
      at: isoTime(part.created_at),
    });
  }
  return messages;
}

/** The subject shown in the case list: the conversation title, then the source subject. */
export function subjectFrom(conversation: IntercomConversation): string | null {
  return conversation.title?.trim() || conversation.source?.subject?.trim() || null;
}

/** A deep link back to the conversation when Intercom supplied one. */
export function conversationUrl(conversation: IntercomConversation): string | null {
  return conversation.links?.conversation?.trim() || null;
}

export interface PendingSend {
  text: string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/**
 * What to do when the teammate captures a send. Pure: the Canvas Kit glue only forwards the answer.
 * This never blocks Intercom's own send; a `need-reason` answer withholds the capture until the
 * reason picker is used.
 */
export function decideOnSend(input: {
  conversation: IntercomConversation;
  draft: DraftState | null;
  draftFields?: Record<string, unknown>;
  send: PendingSend;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the capture was pressed; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const draftFields = input.draftFields ?? {};
  const sentFields = send.fields ?? {};
  const hasFields =
    settings.decisionFields.length > 0 ||
    Object.keys(draftFields).length > 0 ||
    Object.keys(sentFields).length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: sentFields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const id = String(conversation.id);
  const body: CaptureCreate = {
    source: "intercom",
    externalId: `ic:${id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: subjectFrom(conversation),
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversationUrl(conversation),
    tags: [DRAFT_TAGS[draft.origin]],
    metadata: { conversationId: id },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/** Short status line for the Canvas Kit panel. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  return `Draft inserted · ${wordCount(d.text)} words`;
}

/** The chips the teammate sees, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
