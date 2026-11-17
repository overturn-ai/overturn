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
 * A message as the plugin sees it through the Front context (`listMessages`).
 * Front stores the composer body and the sent body in the same HTML, so a sent reply is
 * matched back to the draft it came from (a signature may be appended on the way out).
 */
export interface FrontMessage {
  id: string;
  body: string;
  /** `outbound` is a teammate's reply, `inbound` came from the contact. */
  status?: "inbound" | "outbound" | string;
  author?: string | null;
  at?: string | null;
}

/** Front's internal comments are notes: they belong in the context, never as a sent reply. */
export interface FrontComment {
  id: string;
  body: string;
  author?: string | null;
  at?: string | null;
}

/** What the plugin knows about the conversation, read through the Front context. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  recipientEmail: string | null;
  recipientName: string | null;
  tags: readonly string[];
  /** Oldest first, as `listMessages` returns them. */
  messages: readonly FrontMessage[];
  comments: readonly FrontComment[];
  /** Conversation custom fields an admin mapped as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Refuse to record a changed reply until a reason code is picked. */
  requireReason: boolean;
  /** Also include internal comments in the context (they are never a `sent` answer). */
  captureComments: boolean;
  /** Drafts shorter than this never count (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, only conversations carrying this tag are read at all. */
  scopeTag: string | null;
  /** `coverage,reserve` → conversation custom fields that are the decision, by label. */
  decisionFields: readonly string[];
  /** Which quick-pick reasons the teammate sees. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureComments: true,
  minDraftChars: 80,
  scopeTag: null,
  decisionFields: [],
  reasonPack: "support",
};

/** Parses the plugin settings (query string on the plugin URL, or the stored copy). */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const text = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const flag = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    if (value === true || value === "true" || value === "1") return true;
    if (value === false || value === "false" || value === "0") return false;
    return fallback;
  };
  const min = Number(text("min_draft_chars"));
  return {
    baseUrl: (text("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: text("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: flag("require_reason", DEFAULT_SETTINGS.requireReason),
    captureComments: flag("capture_comments", DEFAULT_SETTINGS.captureComments),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: text("scope_tag"),
    decisionFields: (text("decision_fields") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    reasonPack: reasonPackFrom(text("reason_pack")),
  };
}

export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}

/** With a scope tag, conversations without it are never read, not even the composer. */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. Front hands the plugin the composer body on every context
 * update: the first time it goes from (nearly) empty to reply length in one update, that
 * text was inserted (an AI assist, a rule, a paste), not typed. A drafting agent that
 * recorded its run with the SDK is found by conversation id, and the teammate can mark
 * the current text by hand.
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
      const previous = last;
      const first = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - previous.text.length;
      const jump =
        grew >= opts.minDraftChars &&
        (previous.text.length < opts.minDraftChars / 2 || now - previous.at > window);
      if (jump || (first && text.length >= opts.minDraftChars)) {
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

/** Front hands bodies back as HTML; the case wants the text the human read. */
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

/** The thread the teammate saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot, includeComments = true): CaptureMessage[] {
  const messages: CaptureMessage[] = conversation.messages
    .filter((m) => stripHtml(m.body))
    .map((m) => ({
      role: m.status === "outbound" ? "agent" : "customer",
      author: m.author ?? null,
      content: stripHtml(m.body),
      at: m.at ?? null,
    }));
  const notes: CaptureMessage[] = includeComments
    ? conversation.comments
        .filter((c) => stripHtml(c.body))
        .map((c) => ({
          role: "note",
          author: c.author ?? null,
          content: stripHtml(c.body),
          at: c.at ?? null,
        }))
    : [];
  return [...messages, ...notes];
}

/**
 * Whether a sent body is the draft that produced it. Front may append the signature and
 * re-wrap the HTML, so equality is too strict: the draft's opening is the anchor.
 */
export function sameReply(draftHtml: string, sentHtml: string): boolean {
  const draft = stripHtml(draftHtml);
  const sent = stripHtml(sentHtml);
  if (!draft || !sent) return false;
  if (draft === sent) return true;
  const head = draft.slice(0, 120);
  if (sent.startsWith(head)) return true;
  if (sent.startsWith(draft.slice(0, 60))) return true;
  return head.length >= 60 && sent.includes(head.slice(0, 60));
}

/**
 * The message a send just produced, if any. Front has no send event: the composer context
 * disappears and the conversation context comes back with one more outbound message, so the
 * send is read from the thread and matched against the draft.
 */
export function newlySent(
  messages: readonly FrontMessage[],
  input: { draftText: string; draftAt: number; seenIds?: readonly string[]; toleranceMs?: number },
): FrontMessage | null {
  const tolerance = input.toleranceMs ?? 120_000;
  const seen = new Set(input.seenIds ?? []);
  const candidates = messages.filter((m) => {
    if (m.status !== "outbound" || !stripHtml(m.body) || seen.has(m.id)) return false;
    const at = m.at ? Date.parse(m.at) : Number.NaN;
    return !Number.isFinite(at) || at >= input.draftAt - tolerance;
  });
  if (candidates.length === 0) return null;
  const matched = candidates.filter((m) => sameReply(input.draftText, m.body));
  if (matched.length > 0) return matched[matched.length - 1]!;
  // A single fresh outbound with a rewritten opening is still the send (a closing was
  // reworded after the draft was captured); two or more are ambiguous, so skip.
  return candidates.length === 1 ? candidates[0]! : null;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "empty" }
  | { action: "need-reason"; changedFields: string[] }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] };

/** What to record when a send is read from the thread. Pure: the glue only posts the body. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  sent: { text: string; fields?: Record<string, unknown> };
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const { conversation, draft, settings } = input;
  const sentText = stripHtml(input.sent.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: input.sent.fields ?? {} } : {}),
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
    context: contextFrom(conversation, settings.captureComments),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [`draft:${draft.origin}`, "outbound-reply"],
    metadata: {
      recipient: conversation.recipientEmail ?? conversation.recipientName ?? null,
    },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
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
  const words = d.text.trim().split(/\s+/).filter(Boolean).length;
  const from = {
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}
