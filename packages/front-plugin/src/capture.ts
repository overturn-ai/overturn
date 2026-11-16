import type { CaptureAnswer, CaptureCreate, CaptureMessage } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

/** What the plugin knows about the Front conversation, read through the Front Plugin SDK. */
export interface ConversationSnapshot {
  id: string;
  subject: string | null;
  recipientEmail: string | null;
  recipientName: string | null;
  /** Oldest first, as returned from the conversation history. */
  messages?: Array<{
    id?: string | number;
    value: string;
    type?: "publicReply" | "internalNote" | "inbound" | "outbound" | "comment" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    isOutbound?: boolean;
    isAgent?: boolean;
    createdAt?: string | null;
  }>;
  /** Fallback / alias for comments or internal notes. */
  comments?: Array<{
    id?: string | number;
    value: string;
    type?: "publicReply" | "internalNote" | "inbound" | "outbound" | "comment" | string;
    authorName?: string | null;
    authorEmail?: string | null;
    isOutbound?: boolean;
    isAgent?: boolean;
    createdAt?: string | null;
  }>;
  /** Custom fields the admin chose as decision fields, by label or id. */
  fields: Record<string, unknown>;
  url: string | null;
}

export type FrontConversationSnapshot = ConversationSnapshot;

export interface AppSettings {
  baseUrl: string;
  agent: string;
  apiKey: string | null;
  /** Block the send until the agent picks a reason when the reply was changed (claims pack default). */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies. */
  captureInternalNotes: boolean;
  /** `custom_field_123:coverage, custom_field_9:reserve` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the app watches only conversations carrying this tag; every other conversation is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the agent sees: the claims pack or the vendor-neutral support pack. */
  reasonPack: ReasonPack;
}

export const DEFAULT_SETTINGS: AppSettings = {
  baseUrl: "https://api.overturn.run",
  agent: "support-reply",
  apiKey: null,
  requireReason: true,
  captureInternalNotes: false,
  decisionFields: [],
  minDraftChars: 80,
  scopeTag: null,
  reasonPack: "support",
};

/** Parses the plugin's metadata settings (strings and booleans from manifest or preferences). */
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
  const fields = (str("decision_fields") ?? str("decisionFields") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const minRaw = raw.min_draft_chars ?? raw.minDraftChars;
  const min =
    typeof minRaw === "number" ? minRaw : Number(str("min_draft_chars") ?? str("minDraftChars") ?? "");
  return {
    baseUrl: (str("overturn_base_url") ?? str("baseUrl") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    apiKey: str("overturn_api_key") ?? str("apiKey") ?? null,
    requireReason: bool("require_reason", bool("requireReason", DEFAULT_SETTINGS.requireReason)),
    captureInternalNotes: bool(
      "capture_internal_notes",
      bool("captureInternalNotes", DEFAULT_SETTINGS.captureInternalNotes),
    ),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag") ?? str("scopeTag"),
    reasonPack: reasonPackFrom(str("reason_pack") ?? str("reasonPack")),
  };
}

/**
 * Whether the plugin should watch this conversation at all. With no scope tag every conversation is watched,
 * but nothing is read beyond the reply box until a draft appears. With a scope tag, conversations without it
 * are never read, not even the reply box.
 */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

/**
 * Where the draft came from. The composer is watched: the first time it goes from (nearly)
 * empty to a reply-sized text in one change, that text was inserted (an AI assist, a macro,
 * a paste), not typed, and it is the draft. The agent can also mark the current text as the
 * draft by hand, and a drafting agent that recorded its run with the SDK is found by conversation id.
 */
export type DraftOrigin = "inserted" | "manual" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
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
      // A jump of reply size in one change (or a reply-sized composer on first sight).
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

function role(m: { type?: string; isOutbound?: boolean; isAgent?: boolean }): CaptureMessage["role"] {
  if (m.type === "internalNote" || m.type === "comment" || m.type === "note") return "note";
  if (m.isOutbound || m.isAgent || m.type === "outbound" || m.type === "publicReply") return "agent";
  return "customer";
}

/** The thread the agent saw, oldest first, as capture context. */
export function contextFrom(conversation: ConversationSnapshot): CaptureMessage[] {
  const items = conversation.messages ?? conversation.comments ?? [];
  return items
    .filter((m) => m.value?.trim())
    .map((m) => ({
      role: role(m),
      author: m.authorEmail ?? m.authorName ?? null,
      content: stripHtml(m.value),
      at: m.createdAt ?? null,
    }));
}

/** Front hands message and draft bodies back as HTML or formatted text; the case wants the text the human read. */
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
  type?: "publicReply" | "internalNote" | string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/** What to do when the agent hits Send. Pure: the Front Plugin SDK glue forwards the answer. */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields?: Record<string, unknown>;
  send: PendingSend;
  /** The picked reason code (claims or support pack), required for a changed send when requireReason is on. */
  reasonCode: string | null;
  /** Optional free-text note. */
  reason: string;
  actor: string | null;
  settings: AppSettings;
  /** When Send was pressed; with the draft's `at`, gives how long it sat in front of the reviewer. */
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };
  const sendType = send.type ?? "publicReply";
  if (sendType === "internalNote" && !settings.captureInternalNotes)
    return { action: "skip", why: "internal-note" };
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields ?? {} } : {}),
  };
  const sentAnswer: CaptureAnswer = { text: sentText, ...(hasFields ? { fields: send.fields ?? {} } : {}) };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const body: CaptureCreate = {
    source: "front",
    externalId: `fr:${conversation.id}`,
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
    url: conversation.url ?? (conversation.id ? `https://app.frontapp.com/open/${conversation.id}` : null),
    tags: [`draft:${draft.origin}`, sendType === "internalNote" ? "internal-note" : "public-reply"],
    metadata: { recipient: conversation.recipientEmail ?? conversation.recipientName ?? null },
  };
  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/** Short status line for the plugin sidebar / composer panel. */
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

/** The chips the agent clicks, for the installed pack. */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}

/** Front SDK shapes accepted by snapshotFromFront */
export interface FrontSdkConversation {
  id: string;
  subject?: string | null;
  recipient?: { handle?: string; name?: string } | null;
  tags?: ReadonlyArray<{ id?: string; name?: string }>;
  draftId?: string | null;
  customFieldAttributes?: ReadonlyArray<{ id?: string; name?: string; value?: unknown }>;
  [key: string]: unknown;
}

export interface FrontSdkMessage {
  id?: string | number;
  subject?: string | null;
  date?: Date | string | number | null;
  status?: "inbound" | "outbound" | string;
  type?: string;
  content?: { body: string; type?: "html" | "text" } | null;
  from?: { handle?: string; name?: string } | null;
  [key: string]: unknown;
}

export interface FrontSdkComment {
  id?: string | number;
  body: string;
  date?: Date | string | number | null;
  author?: { email?: string; name?: string; username?: string } | null;
  [key: string]: unknown;
}

/** Helper converting Front Plugin SDK conversation, messages, and comments into a ConversationSnapshot. */
export function snapshotFromFront(
  conversation: FrontSdkConversation,
  messages: ReadonlyArray<FrontSdkMessage> = [],
  comments: ReadonlyArray<FrontSdkComment> = [],
  settings?: AppSettings,
): ConversationSnapshot {
  const customFields: Record<string, unknown> = {};
  if (conversation.customFieldAttributes) {
    for (const attr of conversation.customFieldAttributes) {
      if (attr.name) customFields[attr.name] = attr.value;
      if (attr.id && !customFields[attr.id]) customFields[attr.id] = attr.value;
    }
  }
  if (settings?.decisionFields) {
    for (const f of settings.decisionFields) {
      if (customFields[f.label] === undefined) {
        customFields[f.label] = customFields[f.id] ?? null;
      }
    }
  }

  const messageItems = messages.map((m) => ({
    id: m.id,
    value: m.content?.body ?? "",
    type: m.status === "inbound" ? "inbound" : "outbound",
    isOutbound: m.status === "outbound",
    isAgent: m.status === "outbound",
    authorName: m.from?.name ?? null,
    authorEmail: m.from?.handle ?? null,
    createdAt: m.date ? (typeof m.date === "string" ? m.date : new Date(m.date).toISOString()) : null,
  }));

  const commentItems = comments.map((c) => ({
    id: c.id,
    value: c.body ?? "",
    type: "internalNote",
    isOutbound: true,
    isAgent: true,
    authorName: c.author?.name ?? c.author?.username ?? null,
    authorEmail: c.author?.email ?? null,
    createdAt: c.date ? (typeof c.date === "string" ? c.date : new Date(c.date).toISOString()) : null,
  }));

  const allMessages = [...messageItems, ...commentItems].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return ta - tb;
  });

  return {
    id: conversation.id,
    subject: conversation.subject ?? null,
    recipientEmail: conversation.recipient?.handle ?? null,
    recipientName: conversation.recipient?.name ?? null,
    messages: allMessages,
    fields: customFields,
    url: `https://app.frontapp.com/open/${conversation.id}`,
  };
}
