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
  const string = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const min = Number(raw.minDraftChars);
  return {
    captureUrl: string("captureUrl") ?? "/capture",
    agent: string("agent") ?? "support-reply",
    reasonPack: reasonPackFrom(raw.reasonPack),
    requireReason: raw.requireReason !== false && raw.requireReason !== "false",
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
  let last: { text: string; at: number } | null = null;
  let draft: DraftState | null = null;
  return {
    onComposer(id: string, text: string, now = Date.now()): DraftState | null {
      const previous = last;
      last = { text, at: now };
      if (draft) return null;
      const first = previous === null && text.length >= minDraftChars;
      const jump =
        previous !== null &&
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

function at(value: Date | string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Only messages already present when the draft was found belong in its prompt. */
export function contextFrom(messages: readonly FrontMessage[]): CaptureMessage[] {
  return messages
    .filter((m) => m.content?.body)
    .map(
      (m): CaptureMessage => ({
        role: m.status === "inbound" ? "customer" : "agent",
        author: m.from?.handle ?? m.from?.name ?? null,
        content: plainText(m.content!.body, m.content!.type),
        at: at(m.date),
      }),
    )
    .filter((m) => m.content);
}

export type CaptureDecision =
  | { action: "skip"; why: "no-draft" | "empty" | "not-outbound" }
  | { action: "need-reason" }
  | { action: "capture"; body: CaptureCreate; changed: boolean };

/** Pure payload builder. The caller confirms that sent is a new message after this draft. */
export function buildCapturePayload(input: {
  conversation: FrontConversation;
  context: readonly FrontMessage[];
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
  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: conversation.subject ?? null,
    context: contextFrom(input.context),
    draft: { text: draftText },
    sent: { text: sentText },
    reason: input.reason.trim() || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
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
