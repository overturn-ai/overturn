import type { CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  reasonPackFrom,
  type ReasonCodeOption,
  type ReasonPack,
} from "@overturn-ai/shared/capture";

export interface FrontMessage {
  id: string;
  date?: string | Date;
  status?: string;
  from?: { name?: string; handle?: string };
  content?: { body?: string; type?: "html" | "text" };
}

export interface FrontConversation {
  id: string;
  subject?: string;
  blurb?: string;
}

export interface FrontDraft {
  id: string;
  subject?: string;
  content: { body: string; type: "html" | "text" };
}

export interface FrontSettings {
  baseUrl: string;
  agent: string;
  apiKey: string;
  requireReason: boolean;
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: Omit<FrontSettings, "apiKey"> = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  reasonPack: "support",
};

export function settingsFrom(raw: Record<string, unknown>, apiKey: string): FrontSettings {
  const str = (key: string): string | null => {
    const value = raw[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const value = raw[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") return value === "true" || value === "1";
    return fallback;
  };
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    apiKey,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

export function stripHtml(input: string): string {
  return normalizeCaptureText(
    input
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

export function contextFrom(messages: readonly FrontMessage[], excludeMessageId?: string): CaptureMessage[] {
  return messages.filter((message) => message.id !== excludeMessageId).map((message) => ({
    role: (message.status === "outbound" ? "agent" : "customer") as CaptureMessage["role"],
    author: message.from?.handle ?? message.from?.name ?? null,
    content: stripHtml(message.content?.body ?? ""),
    at: message.date instanceof Date ? message.date.toISOString() : message.date ?? null,
  })).filter((message) => message.content.length > 0);
}

export interface DraftSnapshot {
  text: string;
  at: number;
  draftId: string;
}

export function snapshotDraft(draft: FrontDraft, now = Date.now()): DraftSnapshot | null {
  const text = stripHtml(draft.content.body);
  if (!text.trim()) return null;
  return { text, at: now, draftId: draft.id };
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "empty" | "same-message" }
  | { action: "need-reason"; changedFields: string[] }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] };

export function buildCapture(input: {
  conversation: FrontConversation;
  messages: readonly FrontMessage[];
  draft: DraftSnapshot | null;
  sent: string;
  actor: string | null;
  reasonCode: string | null;
  reason: string;
  settings: FrontSettings;
  now?: number;
  sentMessageId?: string;
}): SendDecision {
  const sentText = stripHtml(input.sent);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!input.draft) return { action: "skip", why: "no-draft" };

  const diff = diffCaptureAnswers({ text: input.draft.text }, { text: sentText });
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && input.settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${input.conversation.id}`,
    agent: input.settings.agent,
    actor: input.actor,
    subject: input.conversation.subject ?? null,
    context: contextFrom(input.messages, input.sentMessageId),
    draft: { text: input.draft.text },
    sent: { text: sentText },
    reason: input.reason.trim() || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - input.draft.at) / 100) / 10),
    url: null,
    tags: ["draft:observed", "front"],
    metadata: { frontDraftId: input.draft.draftId, draftOrigin: "unverified" },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

export async function postCapture(
  baseUrl: string,
  apiKey: string,
  body: CaptureCreate,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(`${baseUrl.replace(/\/+$/, "")}/v1/capture`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Capture failed (${response.status})`);
}

export function quickReasons(pack: ReasonPack): readonly ReasonCodeOption[] {
  return REASON_PACKS[pack];
}

export function wordCount(text: string): number {
  const normalized = text.trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

export function draftStatus(text: string): string {
  return `Draft detected · ${wordCount(text)} words`;
}
