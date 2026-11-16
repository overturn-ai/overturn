import type { CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

export interface FrontSettings {
  captureUrl: string;
  agent: string;
  reasonPack: ReasonPack;
  requireReason: boolean;
  minDraftChars: number;
}

export function settingsFrom(raw: Record<string, unknown>): FrontSettings {
  // The documented setting names are the Zendesk ones (`reason_pack`,
  // `require_reason`, `min_draft_chars`); the camelCase spellings used by
  // plugin/config.js are accepted as aliases.
  const value = (...keys: string[]): unknown => {
    for (const key of keys) if (raw[key] !== undefined) return raw[key];
    return undefined;
  };
  const string = (...keys: string[]): string | null => {
    const v = value(...keys);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const bool = (fallback: boolean, ...keys: string[]): boolean => {
    const v = value(...keys);
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v === "true" || v === "1";
    return fallback;
  };
  const min = Number(value("minDraftChars", "min_draft_chars"));
  return {
    captureUrl: string("captureUrl", "capture_url") ?? "/capture",
    agent: string("agent") ?? "support-reply",
    reasonPack: reasonPackFrom(value("reasonPack", "reason_pack")),
    requireReason: bool(true, "requireReason", "require_reason"),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : 80,
  };
}

export interface FrontConversation {
  id: string;
  subject?: string;
  draftId?: string;
}

export interface FrontMessage {
  id: string;
  status: "inbound" | "outbound" | string;
  from?: { name?: string; handle?: string };
  date?: Date | string;
  content?: { body: string; type: "html" | "text" };
}

export interface DraftState {
  id: string;
  text: string;
  origin: "inserted" | "preloaded" | "manual";
  at: number;
}

/** A reply-sized jump is a candidate draft. Front does not identify its author as AI. */
export function createDraftDetector(minDraftChars: number, typingWindowMs = 1500) {
  // Same state machine as the Zendesk watcher: the composer is observed from
  // the start (empty included), so a draft that arrives while watching is an
  // insertion. Only a reply-sized composer on the very first sighting — the
  // sidebar opened onto a draft that was already there — is "preloaded".
  let last = { text: "", at: 0 };
  let seen = false;
  let draft: DraftState | null = null;
  return {
    onComposer(id: string, text: string, now = Date.now()): DraftState | null {
      const previous = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const first = firstSight && text.length >= minDraftChars;
      const jump =
        !firstSight &&
        text.length - previous.text.length >= minDraftChars &&
        (previous.text.length < minDraftChars / 2 || now - previous.at > typingWindowMs);
      if (!first && !jump) return null;
      draft = { id, text, origin: first ? "preloaded" : "inserted", at: now };
      return draft;
    },
    current: () => draft,
    set(value: DraftState | null) {
      draft = value;
    },
  };
}

export type DraftDetector = ReturnType<typeof createDraftDetector>;

export function plainText(body: string, type: "html" | "text"): string {
  if (type === "text") return normalizeCaptureText(body);
  return normalizeCaptureText(
    body
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

/** An internal comment (note) on the conversation, as returned by the SDK's listComments. */
export interface FrontComment {
  id: string;
  author?: { name?: string; email?: string } | null;
  createdAt?: Date | string;
  content?: { body: string };
}

function at(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timeOf(value: Date | string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * The thread as context, oldest first: messages plus internal comments as
 * notes, merged by time. Only entries already present when the draft was
 * found belong in its prompt; the caller snapshots both lists at that point.
 */
export function contextFrom(
  messages: readonly FrontMessage[],
  comments: readonly FrontComment[] = [],
): CaptureMessage[] {
  const entries: { time: number | null; order: number; message: CaptureMessage }[] = [];
  let order = 0;
  for (const m of messages) {
    if (!m.content?.body) continue;
    const content = plainText(m.content.body, m.content.type);
    if (!content) continue;
    entries.push({
      time: timeOf(m.date),
      order: order++,
      message: {
        role: m.status === "inbound" ? "customer" : "agent",
        author: m.from?.handle ?? m.from?.name ?? null,
        content,
        at: at(m.date),
      },
    });
  }
  for (const c of comments) {
    if (!c.content?.body) continue;
    const content = plainText(c.content.body, "text");
    if (!content) continue;
    entries.push({
      time: timeOf(c.createdAt),
      order: order++,
      message: {
        role: "note",
        author: c.author?.email ?? c.author?.name ?? null,
        content,
        at: at(c.createdAt),
      },
    });
  }
  entries.sort(
    (a, b) =>
      (a.time ?? Number.POSITIVE_INFINITY) - (b.time ?? Number.POSITIVE_INFINITY) || a.order - b.order,
  );
  return entries.map((entry) => entry.message);
}

export type CaptureDecision =
  | { action: "skip"; why: "no-draft" | "empty" | "not-outbound" }
  | { action: "need-reason" }
  | { action: "capture"; body: CaptureCreate; changed: boolean };

/** Pure payload builder. The caller confirms that sent is a new message after this draft. */
export function buildCapturePayload(input: {
  conversation: FrontConversation;
  context: readonly FrontMessage[];
  comments?: readonly FrontComment[];
  draft: DraftState | null;
  sent: FrontMessage;
  actor: string | null;
  reasonCode: string | null;
  reason: string;
  settings: FrontSettings;
  now?: number;
}): CaptureDecision {
  const { conversation, draft, sent, settings } = input;
  if (!draft) return { action: "skip", why: "no-draft" };
  if (sent.status !== "outbound") return { action: "skip", why: "not-outbound" };
  const sentText = sent.content ? plainText(sent.content.body, sent.content.type) : "";
  if (!sentText) return { action: "skip", why: "empty" };
  const draftText = normalizeCaptureText(draft.text);
  const diff = diffCaptureAnswers({ text: draftText }, { text: sentText });
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) return { action: "need-reason" };
  // Time-to-send is frozen at the moment the reply was actually sent (the
  // message's own timestamp). Waiting for a reason afterwards is not composing
  // time and must not inflate it; only a message with no usable timestamp
  // falls back to the caller's clock.
  const sentTime = timeOf(sent.date);
  const end = sentTime ?? input.now ?? Date.now();
  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject ?? null,
    context: contextFrom(input.context, input.comments ?? []).slice(-500),
    draft: { text: draftText },
    sent: { text: sentText },
    reason: input.reason.trim() || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round((end - draft.at) / 100) / 10),
    url: `https://app.frontapp.com/open/${conversation.id}`,
    tags: [`draft:${draft.origin}`, "public-reply"],
    metadata: { frontDraftId: draft.id, frontMessageId: sent.id },
  };
  return { action: "capture", body, changed: diff.changed };
}

export function quickReasons(settings: FrontSettings) {
  return REASON_PACKS[settings.reasonPack];
}

export function statusLine(draft: DraftState | null): string {
  if (!draft) return "Waiting for a draft";
  const words = draft.text.trim().split(/\s+/).length;
  return `Draft ${draft.origin === "manual" ? "marked by you" : draft.origin === "preloaded" ? "found in the composer" : "inserted"} · ${words} words`;
}
