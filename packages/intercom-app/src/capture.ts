import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the app knows about the Intercom conversation. */
export interface ConversationSnapshot {
  id: string;
  title: string | null;
  contactEmail: string | null;
  contactName: string | null;
  /** Oldest first, matching Intercom conversation_parts order. */
  parts: Array<{
    id?: string;
    body: string;
    partType: "comment" | "note" | string;
    authorType: "user" | "lead" | "admin" | "bot" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    createdAt?: string | null;
  }>;
  tags: string[];
  customAttributes: Record<string, unknown>;
  url: string | null;
}

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Block the send until the agent picks a reason when the reply was changed. */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies. */
  captureInternalNotes: boolean;
  /** `refund_status:refund_status, tier:plan_tier` â†’ decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, only conversations carrying this tag are watched. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: support (default) or claims. */
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

/** Parses the app's metadata settings. */
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

/** Whether the app should watch this conversation at all. */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Origin of the draft in the Intercom composer.
 * Intercom's Fin drafts and human-written replies must remain distinguishable:
 * - `ai` / `recorded`: came from an AI assist or SDK-recorded run (`draft:ai`)
 * - `manual`: human typed or explicitly marked it (`draft:manual`)
 * - `unknown`: origin was not told (`draft:unknown`); never guess `ai`
 */
export type DraftOrigin = "ai" | "manual" | "recorded" | "unknown";

export function originTag(origin: DraftOrigin): "draft:ai" | "draft:manual" | "draft:unknown" {
  if (origin === "ai" || origin === "recorded") return "draft:ai";
  if (origin === "manual") return "draft:manual";
  return "draft:unknown";
}

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number, explicitOrigin?: DraftOrigin): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now(), explicitOrigin) {
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
        const origin: DraftOrigin = explicitOrigin ?? "unknown";
        draft = { text, origin, at: now };
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

function role(p: ConversationSnapshot["parts"][number]): CaptureMessage["role"] {
  if (p.partType === "note") return "note";
  return p.authorType === "admin" || p.authorType === "bot" ? "agent" : "customer";
}

/** The conversation thread the expert saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  return conversation.parts
    .filter((p) => p.body?.trim())
    .map((p) => ({
      role: role(p),
      author: p.authorEmail ?? p.authorName ?? null,
      content: stripHtml(p.body),
      at: p.createdAt ?? null,
    }));
}

/** Intercom hands conversation bodies back as HTML; the case wants the text the human read. */
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

export interface PendingSend {
  text: string;
  type: "comment" | "note" | string;
  fields: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the agent sends a reply in Intercom. Pure: Canvas Kit glue only forwards the result. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  send: PendingSend;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  if (send.type === "note" && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields } : {}) };
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
    subject: conversation.title,
    context: contextFrom(conversation),
    draft: draftAnswer,
    send: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: conversation.url,
    tags: [originTag(draft.origin), send.type === "note" ? "internal-note" : "public-reply"],
    metadata: { contact: conversation.contactEmail ?? conversation.contactName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the Intercom Canvas Kit inbox card. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted Â· approved";
    return lastResult.dedup ? "Captured Â· already in the suite" : "Captured Â· edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = stripHtml(d.text).trim().split(/\s+/).filter(Boolean).length;
  const from: Record<DraftOrigin, string> = {
    ai: "inserted",
    manual: "marked by you",
    recorded: "recorded by your agent",
    unknown: "found in the composer",
  };
  return `Draft ${from[d.origin]} Â· ${words} words`;
}

/** The quick-pick reason options for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}

export type CanvasComponent =
  | { type: "text"; text: string; style?: "header" | "muted" | "error" | "paragraph" }
  | {
      type: "single-select";
      id: string;
      label: string;
      options: Array<{ type: "option"; id: string; text: string }>;
      value?: string;
    }
  | {
      type: "input";
      id: string;
      label: string;
      placeholder?: string;
      value?: string;
    }
  | {
      type: "button";
      id: string;
      label: string;
      style?: "primary" | "secondary" | "link";
      action: { type: "submit" };
    };

export interface CanvasResponse {
  canvas: {
    content: {
      components: CanvasComponent[];
    };
  };
}

/** Builds an Intercom Canvas Kit inbox surface response. */
export function buildCanvas(input: {
  draft: DraftState | null;
  settings: AppSettings,ì(€±…ÍÑI•ÍÕ±Ğèì­¥¹èÍÑÉ¥¹œì¡…¹•è‰½½±•…¸ì‘•‘ÕÀè‰½½±•…¸ôğ¹Õ±°ì(€•ÉÉ½É5•ÍÍ…”èÍÑÉ¥¹œğ¹Õ±°ì(€Í•±•Ñ•‘I•…Í½¹½‘”üèÍÑÉ¥¹œğ¹Õ±°ì(€É•…Í½¹9½Ñ”üèÍÑÉ¥¹œì)ô¤è…¹Ù…ÍI•ÍÁ½¹Í”ì(€½¹ÍĞ½µÁ½¹•¹ÑÌè…¹Ù…Í½µÁ½¹•¹Ñmt€ôl(€€€ìÑåÁ”è€‰Ñ•áĞˆ°Ñ•áĞèÍÑ…ÑÕÍ1¥¹”¡¥¹ÁÕĞ¹‘É…™Ğ°¥¹ÁÕĞ¹±…ÍÑI•ÍÕ±Ğ¤°ÍÑå±”è€‰¡•…‘•Èˆô°(€€€ì(€€€€€ÑåÁ”è€‰Í¥¹±”µÍ•±•Ğˆ°(€€€€€¥è€‰É•…Í½¹}½‘”ˆ°(€€€€€±…‰•°è€‰]¡ä‘¥å½Ô¡…¹”¥Ğüˆ°(€€€€€½ÁÑ¥½¹ÌèÅÕ¥­I•…Í½¹Ì¡¥¹ÁÕĞ¹Í•ÑÑ¥¹Ì¤¹µ…À ¡È¤€ôø€¡ì(€€€€€€€ÑåÁ”è€‰½ÁÑ¥½¸ˆ°(€€€€€€€¥èÈ¹½‘”°(€€€€€€€Ñ•áĞèÈ¹±…‰•°°(€€€€€ô¤¤°(€€€€€€¸¸¸¡¥¹ÁÕĞ¹Í•±•Ñ•‘I•…Í½¹½‘”€üìÙ…±Õ”è¥¹ÁÕĞ¹Í•±•Ñ•‘I•…Í½¹½‘”ô€èíô¤°(€€€ô°(€€€ì(€€€€€ÑåÁ”è€‰¥¹ÁÕĞˆ°(€€€€€¥è€‰É•…Í½¹}¹½Ñ”ˆ°(€€€€€±…‰•°è€‰=ÁÑ¥½¹…°¹½Ñ”ˆ°(€€€€€Á±…•¡½±‘•Èè€‰¹åÑ¡¥¹œ•±Í”ü=ÁÑ¥½¹…°¸ˆ°(€€€€€€¸¸¸¡¥¹ÁÕĞ¹É•…Í½¹9½Ñ”€üìÙ…±Õ”è¥¹ÁÕĞ¹É•…Í½¹9½Ñ”ô€èíô¤°(€€€ô°(€€€ì(€€€€€ÑåÁ”è€‰‰ÕÑÑ½¸ˆ°(€€€€€¥è€‰µ…É­}‘É…™Ğˆ°(€€€€€±…‰•°è€‰UÍ”Ñ¡”ÕÉÉ•¹ĞÑ•áĞ…ÌÑ¡”‘É…™Ğˆ°(€€€€€ÍÑå±”è€‰±¥¹¬ˆ°(€€€€€…Ñ¥½¸èìÑåÁ”è€‰ÍÕ‰µ¥Ğˆô°(€€€ô°(€€€ì(€€€€€ÑåÁ”è€‰‰ÕÑÑ½¸ˆ°(€€€€€¥è€‰…ÁÑÕÉ•}Í•¹ˆ°(€€€€€±…‰•°è€‰…ÁÑÕÉ”Í•¹ˆ°(€€€€€ÍÑå±”è€‰ÁÉ¥µ…Éäˆ°(€€€€€…Ñ¥½¸èìÑåÁ”è€‰ÍÕ‰µ¥Ğˆô°(€€€ô°(€tì((€¥˜€¡¥¹ÁÕĞ¹•ÉÉ½É5•ÍÍ…”¤ì(€€€½µÁ½¹•¹ÑÌ¹ÁÕÍ ¡ìÑåÁ”è€‰Ñ•áĞˆ°Ñ•áĞè¥¹ÁÕĞ¹•ÉÉ½É5•ÍÍ…”°ÍÑå±”è€‰•ÉÉ½Èˆô¤ì(€ô((€É•ÑÕÉ¸ì…¹Ù…Ìèì½¹Ñ•¹Ğèì½µÁ½¹•¹ÑÌôôôì)ô(