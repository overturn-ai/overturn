import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import { diffCaptureAnswers, normalizeCaptureText, REASON_PACKS, reasonPackFrom, type ReasonCodeOption, type ReasonPack } from "@overturn-ai/shared/capture";

export interface AppSettings {
  baseUrl: string;
  agent: string;
  requireReason: boolean;
  reasonPack: ReasonPack;
}
export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  reasonPack: "support",
};
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const text = (key: string): string | null => typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim() : null;
  const requireReason = raw.require_reason;
  return {
    baseUrl: (text("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: text("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: typeof requireReason === "boolean" ? requireReason : requireReason === "false" || requireReason === "0" ? false : true,
    reasonPack: reasonPackFrom(text("reason_pack")),
  };
}
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] { return REASON_PACKS[settings.reasonPack]; }

/** Never infer AI from length, insertion, paste, or a prefilled composer. */
export type DraftOrigin = "ai" | "manual" | "unknown";
export function originFrom(signal: unknown): DraftOrigin {
  if (signal === "fin_assist") return "ai";
  if (signal === "human_typed") return "manual";
  return "unknown";
}
export interface DraftState { text: string; origin: DraftOrigin; at: number; fields?: Record<string, unknown>; runId?: string; model?: string }
export interface ConversationSnapshot { id: string; subject?: string | null; url?: string | null; messages: Array<{ role: CaptureMessage["role"]; author?: string | null; content: string; at?: string | null }> }
export interface SentReply { text: string; fields?: Record<string, unknown> }
export type SendDecision =
  | { action: "skip"; why: "no-draft" | "empty" | "reason-required" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] };

export function decideOnSend(input: {
  conversation: ConversationSnapshot; draft: DraftState | null; sent: SentReply;
  actor: string | null; reasonCode: string | null; reason: string; settings: AppSettings; now?: number;
}): SendDecision {
  const { draft, sent, settings, conversation } = input;
  const sentText = normalizeCaptureText(sent.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!draft || !normalizeCaptureText(draft.text)) return { action: "skip", why: "no-draft" };
  const draftAnswer: CaptureAnswer = { text: normalizeCaptureText(draft.text), ...(draft.fields ? { fields: draft.fields } : {}) };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(sent.fields ? { fields: sent.fields } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reasonCode = input.reasonCode?.trim() || null;
  // Canvas Kit cannot intercept the native send. Discard an incomplete capture, never stop a reply.
  if (diff.changed && settings.requireReason && !reasonCode) return { action: "skip", why: "reason-required" };
  const body: CaptureCreate = {
    source: "intercom", externalId: `ic:${conversation.id}`, agent: settings.agent,
    actor: input.actor, subject: conversation.subject ?? null,
    context: conversation.messages.filter((m) => m.content.trim()).map((m) => ({ role: m.role, author: m.author ?? null, content: normalizeCaptureText(m.content), at: m.at ?? null })),
    draft: draftAnswer, sent: sentAnswer, reason: input.reason.trim() || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null, draftModel: draft.model ?? null,
    url: conversation.url ?? null, tags: [`draft:${draft.origin}`],
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}
export function statusLine(draft: DraftState | null): string {
  if (!draft) return "Waiting for a draft";
  const count = normalizeCaptureText(draft.text).split(/\s+/).filter(Boolean).length;
  return `Draft inserted · ${count} words`;
}
