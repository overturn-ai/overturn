import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import { diffCaptureAnswers, normalizeCaptureText, REASON_PACKS, type ReasonCodeOption, type ReasonPack, reasonPackFrom } from "@overturn-ai/shared/capture";

export interface TicketSnapshot {
  id: string;
  subject: string | null;
  requesterEmail: string | null;
  comments: Array<{ id?: string; value: string; type: string; authorEmail?: string | null; createdAt?: string | null; }>;
  fields: Record<string, unknown>;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  requireReason: boolean;
  minDraftChars: number;
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  minDraftChars: 80,
  reasonPack: "support",
};

export function stripHtml(html: string): string {
  return normalizeCaptureText(html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " "));
}

export function decideOnSend(input: {
  ticket: TicketSnapshot;
  draft: { text: string; at: number } | null;
  sentText: string;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}) {
  const { ticket, draft, sentText, settings } = input;
  if (!draft || !sentText.trim()) return { action: "skip" };

  const draftAnswer: CaptureAnswer = { text: stripHtml(draft.text) };
  const sentAnswer: CaptureAnswer = { text: stripHtml(sentText) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);

  if (diff.changed && settings.requireReason && !input.reasonCode) {
    return { action: "need-reason" };
  }

  const body: CaptureCreate = {
    source: "gorgias",
    externalId: `gr:${ticket.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: ticket.subject,
    context: [],
    draft: draftAnswer,
    sent: sentAnswer,
    reason: input.reason.trim() || null,
    reasonCode: diff.changed ? input.reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 1000)),
    url: null,
    tags: ["public-reply"],
    metadata: { requester: ticket.requesterEmail },
  };
  return { action: "capture", body };
}

export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}