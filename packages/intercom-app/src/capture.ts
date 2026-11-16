import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the app knows about the conversation, read through the Intercom REST API. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  contactEmail: string | null;
  contactName: string | null;
  /** Oldest first: the opening message, then each conversation part. */
  parts: Array<{
    id?: string;
    body: string;
    /** `comment` is visible to the customer, `note` is internal. */
    partType: "comment" | "note" | string;
    authorType: "user" | "lead" | "contact" | "admin" | "bot" | "team" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    createdAt?: string | null;
  }>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Refuse to capture a changed reply until the agent picks a reason. */
  requireReason: boolean;
  /** Also capture internal notes, not only replies the customer sees. */
  captureInternalNotes: boolean;
  /** Which quick-pick reasons the agent sees: the claims pack or the vendor-neutral support pack. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  requireReason: true,
  captureInternalNotes: false,
  reasonPack: "support",
};

/** Parses the app's settings (environment variables or a config blob: strings and booleans). */
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
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
}

/**
 * Where the draft came from. Canvas Kit cannot see the composer, so an origin is only ever one
 * we were told: `ai` when a drafting agent recorded its run (found by conversation id) or the
 * agent said an assist wrote it, `manual` when the agent said they wrote it. Anything else is
 * `unknown`, and an unknown draft carries no `draft:*` tag; guessing is worse than unknown.
 */
export type DraftOrigin = "ai" | "manual" | "unknown";

export function draftOriginFrom(raw: unknown): DraftOrigin {
  return raw === "ai" || raw === "manual" ? raw : "unknown";
}

export function draftTags(origin: DraftOrigin): string[] {
  return origin === "unknown" ? [] : [`draft:${origin}`];
}

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

function role(p: ConversationSnapshot["parts"][number]): CaptureMessage["role"] {
  if (p.partType === "note") return "note";
  if (p.authorType === "admin") return "agent";
  if (p.authorType === "bot") return "system";
  return "customer";
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  return conversation.parts
    .map((p) => ({ p, content: stripHtml(p.body) }))
    .filter(({ content }) => content)
    .map(({ p, content }) => ({
      role: role(p),
      author: p.authorEmail ?? p.authorName ?? null,
      content,
      at: p.createdAt ?? null,
    }));
}

/** Intercom hands message bodies back as HTML; the case wants the text the human read. */
export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

export interface PendingSend {
  text: string;
  type: "comment" | "note" | string;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the agent presses Capture. Pure: the server only forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  send: PendingSend;
  /** The picked reason code, required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When Capture was pressed; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "note" && !settings.captureInternalNotes) return { action: "skip", why: "internal-note" };
  if (!draft || !stripHtml(draft.text)) return { action: "skip", why: "no-draft" };

  const draftAnswer: CaptureAnswer = { text: stripHtml(draft.text) };
  const sentAnswer: CaptureAnswer = { text: sentText };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

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
    tags: [...draftTags(draft.origin), send.type === "note" ? "internal-note" : "public-reply"],
    metadata: { requester: conversation.contactEmail ?? conversation.contactName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the panel. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).filter(Boolean).length;
  return `Draft inserted · ${words} words`;
}

/** The chips the agent clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
