import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import { diffCaptureAnswers, normalizeCaptureText, REASON_PACKS, type ReasonPack } from "@overturn-ai/shared/capture";

export interface IntercomConversation {
  id: string;
  subject: string | null;
  participants: Array<{ email: string | null; name: string | null }>;
  messages: Array<{ id: string; body: string; author: { type: string; email: string | null }; createdAt: number }>;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  requireReason: boolean;
  reasonPack: ReasonPack;
  minDraftChars: number;
}

export function contextFrom(conv: IntercomConversation): CaptureMessage[] {
  return conv.messages.map((m) => ({
    role: m.author.type === "admin" ? "agent" : "customer",
    author: m.author.email,
    content: normalizeCaptureText(m.body.replace(/<[^>]+>/g, "")),
    at: new Date(m.createdAt).toISOString(),
  }));
}

export function decideOnSend(input: {
  conversation: IntercomConversation;
  draft: { text: string; origin: "ai" | "manual" };
  sentText: string;
  reasonCode: string | null;
  reason: string;
  settings: AppSettings;
}): CaptureCreate | { action: "need-reason" } {
  const draftAnswer: CaptureAnswer = { text: normalizeCaptureText(input.draft.text) };
  const sentAnswer: CaptureAnswer = { text: normalizeCaptureText(input.sentText) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);

  if (diff.changed && input.settings.requireReason && !input.reasonCode) {
    return { action: "need-reason" };
  }

  return {
    source: "intercom",
    externalId: `ic:${input.conversation.id}`,
    agent: input.settings.agent,
    context: contextFrom(input.conversation),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: input.reason || null,
    reasonCode: diff.changed ? input.reasonCode : null,
    tags: [`draft:${input.draft.origin}`],
  };
}