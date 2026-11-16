import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the app knows about the conversation, read from the Canvas Kit webhook payload. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  /** The customer on the conversation: the contact Intercom shows the teammate. */
  contactEmail: string | null;
  contactName: string | null;
  /** Oldest first: the opening message, then the conversation parts as Intercom returns them. */
  parts: Array<{
    id?: string;
    body: string;
    /** Intercom part_type: "comment" for a visible message, "note" for an internal note. */
    partType: "comment" | "note" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    /** Intercom author type: "admin" (teammate), "bot" (Fin / automation), "user" / "lead" (the customer). */
    authorType?: string | null;
    createdAt?: string | null;
  }>;
  /** Conversation attributes the admin chose as decision fields, by label. */
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
  /** `coverage_amount:coverage, reserve_amount:reserve` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the app watches only conversations carrying this tag; every other conversation is never read. */
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
 * Whether the app should watch this conversation at all. With no scope tag every
 * conversation is watched, but nothing is read beyond the thread until a draft appears
 * (see main.ts). With a scope tag, conversations without it are never read.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from, in the words the capture contract scores by (the shared
 * draftOriginSchema): "ai" when an assist put it in front of the expert — a Fin part on
 * the conversation, or a run the drafting agent recorded with the SDK — "manual" when the
 * expert marked the text as the draft by hand, "unknown" when nobody said. Canvas Kit has
 * no composer feed, so there is no typing/insert detection here: a draft is only ever one
 * of these, never a guess.
 */
export type DraftOrigin = "ai" | "manual" | "recorded" | "unknown";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  /** The conversation part the draft came from, when it is one (a Fin part). */
  partId?: string;
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
 * The AI draft on the conversation, if one is waiting: Fin's reply sits on the thread as
 * a bot-authored comment part, and it is the draft until the expert answers it. Only the
 * newest part can be it — anything after it means the moment has passed.
 */
export function findAiDraft(conversation: ConversationSnapshot): DraftState | null {
  const last = conversation.parts[conversation.parts.length - 1];
  if (last?.partType !== "comment" || last?.authorType !== "bot") return null;
  const text = stripHtml(last.body);
  if (!text) return null;
  const at = last.createdAt ? Date.parse(last.createdAt) : Number.NaN;
  return { text, origin: "ai", partId: last.id, at: Number.isNaN(at) ? Date.now() : at };
}

/**
 * What the expert sent: the newest comment part a teammate authored after the draft
 * appeared. Internal notes are not sends. Null while the reply has not gone out.
 */
export function findSentReply(
  conversation: ConversationSnapshot,
  draft: DraftState,
): { text: string; partId?: string } | null {
  const parts = conversation.parts;
  const from = draft.partId ? parts.findIndex((p) => p.id === draft.partId) : -1;
  for (let i = parts.length - 1; i > from; i--) {
    const p = parts[i]!;
    if (p.partType === "comment" && p.authorType === "admin") {
      const text = stripHtml(p.body);
      if (text) return { text, partId: p.id };
    }
  }
  return null;
}

function role(p: ConversationSnapshot["parts"][number]): CaptureMessage["role"] {
  if (p.partType === "note") return "note";
  return p.authorType === "admin" || p.authorType === "bot" ? "agent" : "customer";
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  return conversation.parts
    .filter((p) => p.body?.trim())
    .map((p) => ({
      role: role(p),
      author: p.authorEmail ?? p.authorName ?? null,
      content: stripHtml(p.body),
      at: p.createdAt ?? null,
    }));
}

/** Intercom hands part bodies back as HTML; the case wants the text the human read. */
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
  type: "reply" | "note" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do with the expert's reply. Pure: the Canvas Kit glue only forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code (claims pack), required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the reply was sent; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
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

  const tag = draftTag(draft.origin);
  const body: CaptureCreate = {
    source: "intercom",
    externalId: `ic:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [...(tag ? [tag] : []), send.type === "note" ? "internal-note" : "public-reply"],
    metadata: { contact: conversation.contactEmail ?? conversation.contactName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the canvas. */
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
