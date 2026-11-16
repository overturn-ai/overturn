import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** The schema allows 500 context messages; the most recent ones matter most. */
const MAX_CONTEXT = 500;

/** What the plugin knows about the conversation, read through the Front plugin SDK. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  /** Customer handle (email), when Front gives one. */
  recipient: string | null;
  /** Oldest first. */
  messages: Array<{
    id: string;
    /** HTML or plain text, as Front returns it. */
    body: string;
    isInbound: boolean;
    authorName?: string | null;
    authorEmail?: string | null;
    createdAt?: string | null;
  }>;
  /** Internal comments, oldest first. */
  comments: Array<{ id: string; body: string; authorName?: string | null; createdAt?: string | null }>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Block (hold) the capture until the agent picks a reason when the reply was changed. */
  requireReason: boolean;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** Which quick-pick reasons the agent sees: the claims pack or the vendor-neutral support pack. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  minDraftChars: 80,
  reasonPack: "support",
};

/** Parses the plugin's settings (strings and booleans, as stored by the config form). */
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
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a template,
 * a paste), not typed, and it is the draft. The agent can also mark the current text by hand.
 */
export type DraftOrigin = "inserted" | "manual" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
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

/** Front hands message bodies back as HTML; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}

/** The thread the agent saw, oldest first, as capture context (latest 500 at most). */
export function contextFrom(c: ConversationSnapshot): CaptureMessage[] {
  const all: Array<CaptureMessage & { order: number }> = [
    ...c.messages.map((m, i) => ({
      role: (m.isInbound ? "customer" : "agent") as CaptureMessage["role"],
      author: m.authorEmail ?? m.authorName ?? null,
      content: stripHtml(m.body),
      at: m.createdAt ?? null,
      order: i,
    })),
    ...c.comments.map((m, i) => ({
      role: "note" as const,
      author: m.authorName ?? null,
      content: stripHtml(m.body),
      at: m.createdAt ?? null,
      order: i,
    })),
  ].filter((m) => m.content);
  // Messages and comments interleave by time when both carry one; otherwise messages come first.
  const stamped = all.every((m) => m.at);
  const sorted = stamped ? [...all].sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? "")) : all;
  return sorted.slice(-MAX_CONTEXT).map(({ order: _order, ...m }) => m);
}

export interface PendingSend {
  text: string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do once the agent has sent. Pure: the SDK glue only forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields?: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When the send happened; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(input.draftFields ? { fields: input.draftFields as CaptureAnswer["fields"] } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(send.fields ? { fields: send.fields as CaptureAnswer["fields"] } : {}),
  };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject,
    context: contextFrom(conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    url: conversation.url,
    tags: [`draft:${draft.origin}`],
    metadata: { recipient: conversation.recipient },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the panel. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = stripHtml(d.text).split(/\s+/).filter(Boolean).length;
  const from = { inserted: "inserted", manual: "marked by you", preloaded: "found in the composer" }[
    d.origin
  ];
  return `Draft ${from} · ${words} words`;
}

/** The chips the agent clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
