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
 * What the app knows about the Gorgias ticket. Gorgias exposes tickets via
 * its API (and webhooks); this mirrors the Zendesk TicketSnapshot shape but is
 * shaped to what Gorgias returns in its ticket sidebar context.
 */
export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  requesterEmail: string | null;
  requesterName: string | null;
  comments: Array<{
    id?: number | string;
    value: string;
    type: "publicReply" | "internalNote" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    isAgent?: boolean;
    createdAt?: string | null;
  }>;
  fields: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  requireReason: boolean;
  captureInternalNotes: boolean;
  decisionFields: Array<{ id: string; label: string }>;
  minDraftChars: number;
  scopeTag: string | null;
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

export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

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
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      const grew = text.length - prev.text.length;
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: "inserted", at: now };
        return draft;
      }
      return null;
    },
    current(): DraftState | null {
      return draft;
    },
    set(d: DraftState | null): void {
      draft = d;
    },
  };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<p[^>]*>/gi, "\n\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<div[^>]*>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function contextFrom(ticket: TicketSnapshot): CaptureMessage["context"] {
  return {
    ticketId: String(ticket.id),
    source: "gorgias",
    externalId: `gr:${ticket.id}`,
    subject: ticket.subject,
    requester: ticket.requesterEmail ?? ticket.requesterName ?? null,
    requesterEmail: ticket.requesterEmail ?? null,
    requesterName: ticket.requesterName ?? null,
    comments: ticket.comments.map((c) => ({
      id: c.id ?? null,
      value: stripHtml(c.value),
      type: c.type,
      authorName: c.authorName ?? null,
      authorEmail: c.authorEmail ?? null,
      isAgent: c.isAgent ?? false,
      createdAt: c.createdAt ?? null,
    })),
    fields: ticket.fields,
    url: ticket.url,
  };
}

export interface DecideInput {
  ticket: TicketSnapshot;
  composerText: string;
  now?: number;
  actor?: string;
  settings?: AppSettings;
}

export interface DecideResult {
  action: "skip" | "approve" | "capture" | "need-reason";
  draft?: { text: string };
  sent?: { text: string };
  changed?: boolean;
  changedFields?: string[];
  body?: CaptureCreate;
}

export function decideOnSend(input: DecideInput): DecideResult {
  const settings = input.settings ?? DEFAULT_SETTINGS;
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
  const draft = detector.onComposer(input.composerText, input.now);
  if (!draft) return { action: "skip" };

  const sentText = stripHtml(input.composerText);
  const draftAnswer: CaptureAnswer = { text: stripHtml(draft.text) };
  const sentAnswer: CaptureAnswer = { text: sentText };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = "";

  if (diff.changed && settings.requireReason && !reason) {
    return { action: "need-reason", draft: { text: draft.text }, changed: true };
  }

  const body: CaptureCreate = {
    source: "gorgias",
    externalId: `gr:${input.ticket.id}`,
    agent: settings.agent,
    actor: input.actor ?? "gorgias-agent",
    subject: input.ticket.subject,
    context: contextFrom(input.ticket),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? null : null,
    secondsToSend: 0,
    draftRunId: null,
    draftModel: null,
    url: input.ticket.url,
    tags: [`draft:${draft.origin}`],
    metadata: { requester: input.ticket.requesterEmail ?? input.ticket.requesterName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

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
    inserted: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    preloaded: "found in the composer",
  }[d.origin];
  return `Draft ${from} · ${words} words`;
}

export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
