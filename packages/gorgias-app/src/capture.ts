import type { CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

export interface GorgiasMessage {
  id?: number | string;
  body_text?: string | null;
  body_html?: string | null;
  sender?: { email?: string | null; name?: string | null };
  from_agent?: boolean;
  via?: string | null;
  internal?: boolean;
  created_datetime?: string | null;
}

export interface GorgiasTicketSnapshot {
  id: number | string;
  subject?: string | null;
  customer?: { email?: string | null; name?: string | null } | null;
  messages: GorgiasMessage[];
  fields?: Record<string, unknown>;
  url?: string | null;
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
  const min = Number(str("min_draft_chars") ?? raw.min_draft_chars ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    reasonPack: reasonPackFrom(str("reason_pack")),
  };
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

export function stripHtml(html: string): string {
  return normalizeCaptureText(
    html
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

function role(m: GorgiasMessage): CaptureMessage["role"] {
  if (m.internal) return "note";
  return m.from_agent ? "agent" : "customer";
}

export function contextFrom(ticket: GorgiasTicketSnapshot): CaptureMessage[] {
  return (ticket.messages ?? [])
    .map((m) => ({
      role: role(m),
      author: m.sender?.email ?? m.sender?.name ?? null,
      content: stripHtml(m.body_text?.trim() ? m.body_text : m.body_html ?? ""),
      at: m.created_datetime ?? null,
    }))
    .filter((m) => m.content.trim().length > 0);
}

export interface PendingSend {
  text: string;
  type?: string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

export function decideOnSend(input: {
  ticket: GorgiasTicketSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const { ticket, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const draftText = stripHtml(draft.text);
  const sentFields = send.fields ?? {};
  const diff = diffCaptureAnswers(
    { text: draftText, fields: input.draftFields },
    { text: sentText, fields: sentFields },
  );

  if (diff.changed && settings.requireReason && !input.reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const now = input.now ?? Date.now();
  const secondsToSend = draft.at ? Math.max(0, Math.round((now - draft.at) / 100) / 10) : undefined;
  const body: CaptureCreate = {
    source: "gorgias",
    externalId: `gr:${ticket.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: ticket.subject ?? null,
    context: contextFrom(ticket),
    draft: { text: draftText, fields: Object.keys(input.draftFields).length ? input.draftFields : undefined },
    sent: { text: sentText, fields: Object.keys(sentFields).length ? sentFields : undefined },
    reasonCode: input.reasonCode,
    reason: input.reason?.trim() ? input.reason.trim() : undefined,
    tags: [`draft:${draft.origin}`],
    secondsToSend,
  };
  if (draft.runId) body.draftRunId = draft.runId;
  if (draft.model !== undefined) body.draftModel = draft.model ?? undefined;

  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

export function statusLine(
  d: DraftState | null,
  lastResult: { changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim().split(/\s+/).filter(Boolean).length;
  const from = { inserted: "inserted", manual: "marked by you", recorded: "recorded by your agent", preloaded: "found in the composer" }[d.origin];
  return `Draft ${from} · ${words} words`;
}

export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}
