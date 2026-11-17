import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import { diffCaptureAnswers, normalizeCaptureText, REASON_PACKS, reasonPackFrom, type ReasonPack, type ReasonCodeOption } from "@overturn-ai/shared/capture";

export interface TicketSnapshot {
  id: number | string;
  subject: string | null;
  url: string | null;
  customerEmail: string | null;
  /** Optional ecommerce context; never treat it as a scored decision field. */
  order: Record<string, string | number | boolean | null> | null;
  messages: Array<{ body: string; fromAgent: boolean; internal?: boolean; author?: string | null; at?: string | null }>;
}
export interface AppSettings {
  baseUrl: string;
  agent: string;
  requireReason: boolean;
  reasonPack: ReasonPack;
  minDraftChars: number;
  captureInternalNotes: boolean;
}
export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run", agent: "support-reply", requireReason: true,
  reasonPack: "support", minDraftChars: 80, captureInternalNotes: false,
};
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const text = (key: string): string | null => typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim() : null;
  const flag = (key: string, fallback: boolean): boolean => raw[key] === true || raw[key] === "true" ? true : raw[key] === false || raw[key] === "false" ? false : fallback;
  const min = Number(text("min_draft_chars"));
  return {
    baseUrl: (text("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: text("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: flag("require_reason", DEFAULT_SETTINGS.requireReason),
    reasonPack: reasonPackFrom(text("reason_pack")),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    captureInternalNotes: flag("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
  };
}
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] { return REASON_PACKS[settings.reasonPack]; }
export interface DraftState { text: string; origin: "inserted" | "preloaded" | "manual"; at: number }
export function createDraftDetector(opts: { minDraftChars: number }) {
  let current: DraftState | null = null;
  let previous = "";
  let seen = false;
  return {
    current: (): DraftState | null => current,
    set: (value: DraftState | null): void => { current = value; },
    onComposer(text: string, at = Date.now()): DraftState | null {
      const first = !seen;
      seen = true;
      const jump = text.length - previous.length >= opts.minDraftChars && previous.length < opts.minDraftChars / 2;
      previous = text;
      if (current || (!jump && !(first && text.length >= opts.minDraftChars))) return null;
      current = { text, at, origin: first ? "preloaded" : "inserted" };
      return current;
    },
  };
}
export function statusLine(d: DraftState | null, result: { changed: boolean; dedup: boolean } | null): string {
  if (result) return result.changed ? result.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case" : "Sent as drafted · approved";
  if (!d) return "Waiting for a draft";
  const count = d.text.trim().split(/\s+/).filter(Boolean).length;
  return `Draft ${d.origin === "inserted" ? "inserted" : d.origin === "manual" ? "marked by you" : "found in the composer"} · ${count} words`;
}
export function stripHtml(html: string): string {
  return normalizeCaptureText(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|tr)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
}
export function contextFrom(ticket: TicketSnapshot): CaptureMessage[] {
  return ticket.messages.filter((m) => stripHtml(m.body)).map((m) => ({
    role: m.internal ? "note" : m.fromAgent ? "agent" : "customer",
    author: m.author ?? null, content: stripHtml(m.body), at: m.at ?? null,
  }));
}
export type SendDecision = { action: "skip"; why: "no-draft" | "empty" | "internal-note" } | { action: "need-reason"; changedFields: string[] } | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] };
export function decideOnSend(input: {
  ticket: TicketSnapshot; draft: DraftState | null; sentText: string;
  draftFields: Record<string, unknown>; sentFields: Record<string, unknown>;
  reasonCode: string | null; reason: string; actor: string | null; settings: AppSettings;
  internal?: boolean; now?: number;
}): SendDecision {
  const sentText = stripHtml(input.sentText);
  if (!sentText) return { action: "skip", why: "empty" };
  if (input.internal && !input.settings.captureInternalNotes) return { action: "skip", why: "internal-note" };
  if (!input.draft) return { action: "skip", why: "no-draft" };
  const draft: CaptureAnswer = { text: stripHtml(input.draft.text), ...(Object.keys(input.draftFields).length ? { fields: input.draftFields } : {}) };
  const sent: CaptureAnswer = { text: sentText, ...(Object.keys(input.sentFields).length ? { fields: input.sentFields } : {}) };
  const diff = diffCaptureAnswers(draft, sent);
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && input.settings.requireReason && !reasonCode) return { action: "need-reason", changedFields: diff.changedFields };
  const body: CaptureCreate = {
    source: "gorgias", externalId: `gr:${input.ticket.id}`, agent: input.settings.agent,
    actor: input.actor, subject: input.ticket.subject, context: contextFrom(input.ticket),
    draft, sent, reasonCode: diff.changed ? reasonCode : null, reason: input.reason.trim() || null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - input.draft.at) / 100) / 10),
    url: input.ticket.url, tags: [`draft:${input.draft.origin}`, input.internal ? "internal-note" : "public-reply"],
    metadata: { customer: input.ticket.customerEmail, order: input.ticket.order },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}
