import type { CaptureAnswer, CaptureCreate, CaptureMessage, CaptureResult } from "@overturn-ai/shared";
import {
  diffCaptureAnswers,
  normalizeCaptureText,
  REASON_PACKS,
  type ReasonCodeOption,
  type ReasonPack,
  reasonPackFrom,
} from "@overturn-ai/shared/capture";

// ---------- Intercom Canvas Kit Types ----------

export type CanvasTextComponent = {
  type: "text";
  id?: string;
  text: string;
  style?: "header" | "paragraph" | "muted" | "error";
  align?: "left" | "center" | "right";
};

export type CanvasDropdownOption = {
  type: "option";
  id: string;
  text: string;
};

export type CanvasDropdownComponent = {
  type: "dropdown";
  id: string;
  label?: string;
  options: CanvasDropdownOption[];
  value?: string | null;
  disabled?: boolean;
};

export type CanvasSingleSelectComponent = {
  type: "single-select";
  id: string;
  label?: string;
  options: CanvasDropdownOption[];
  value?: string | null;
  disabled?: boolean;
};

export type CanvasTextareaComponent = {
  type: "textarea";
  id: string;
  label?: string;
  placeholder?: string;
  value?: string | null;
  disabled?: boolean;
};

export type CanvasButtonComponent = {
  type: "button";
  id: string;
  label: string;
  style?: "primary" | "secondary" | "link";
  disabled?: boolean;
  action: {
    type: "submit" | "url" | "sheet";
    url?: string;
  };
};

export type CanvasDividerComponent = {
  type: "divider";
  id?: string;
};

export type CanvasComponent =
  | CanvasTextComponent
  | CanvasDropdownComponent
  | CanvasSingleSelectComponent
  | CanvasTextareaComponent
  | CanvasButtonComponent
  | CanvasDividerComponent;

/**
 * Where the draft came from.
 * Note that Intercom's Fin drafts and a human-written reply must be distinguishable:
 * tag the run `draft:ai` only when the draft came from an assist, `draft:manual` when the human typed it.
 * Guessing an origin we were not told is worse than `unknown`.
 */
export type DraftOrigin = "ai" | "manual" | "unknown" | "inserted" | "recorded" | "preloaded";

export interface DraftState {
  text: string;
  origin: DraftOrigin;
  runId?: string;
  model?: string | null;
  at: number;
}

export interface CanvasStoredData {
  draft?: DraftState | null;
  reasonCode?: string | null;
  reasonNote?: string;
  lastResult?: { kind: string; changed: boolean; dedup: boolean; caseTitle?: string | null } | null;
  [key: string]: unknown;
}

export interface CanvasResponse {
  canvas: {
    content: {
      components: CanvasComponent[];
    };
    stored_data?: CanvasStoredData;
  };
}

// ---------- Conversation Snapshot & Parts ----------

/** A single message or comment part in an Intercom conversation. */
export interface ConversationPart {
  id?: number | string;
  body?: string;
  value?: string; // alias for compatibility
  partType?: "comment" | "note" | string;
  type?: "publicReply" | "internalNote" | string; // alias
  authorName?: string | null;
  authorEmail?: string | null;
  authorRole?: "user" | "lead" | "admin" | "bot" | string;
  isAgent?: boolean;
  createdAt?: string | number | null;
}

/** What the app knows about the Intercom conversation. */
export interface ConversationSnapshot {
  id: number | string;
  subject: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  requesterEmail?: string | null; // alias
  requesterName?: string | null; // alias
  /** Chronological messages in the conversation, oldest first. */
  parts?: ConversationPart[];
  comments?: ConversationPart[]; // alias
  /** Custom attributes the admin chose as decision fields, by label. */
  fields: Record<string, unknown>;
  url: string | null;
}

export function conversationParts(conv: ConversationSnapshot): ConversationPart[] {
  return conv.parts ?? conv.comments ?? [];
}

// ---------- App Settings ----------

export interface AppSettings {
  baseUrl: string;
  agent: string;
  /** Block/prompt when the reply was changed until the agent picks a reason. */
  requireReason: boolean;
  /** Also capture internal notes, not only public replies. */
  captureInternalNotes: boolean;
  /** `custom_field_123:coverage, custom_field_9:reserve` → decision fields by label. */
  decisionFields: Array<{ id: string; label: string }>;
  /** Replies shorter than this never count as a draft (a typed greeting is not a draft). */
  minDraftChars: number;
  /** When set, the app watches only conversations carrying this tag; every other conversation is never read. */
  scopeTag: string | null;
  /** Which quick-pick reasons the teammate sees: support (default) or claims. */
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

/** Parses app settings from manifest parameters, headers, or query objects. */
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
  const rawFields = str("decision_fields") ?? str("decisionFields") ?? "";
  const fields = rawFields
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id!, label: label || id! };
    });
  const minRaw = str("min_draft_chars") ?? str("minDraftChars");
  const min = minRaw !== null ? Number(minRaw) : Number.NaN;

  return {
    baseUrl: (
      str("overturn_base_url") ??
      str("baseUrl") ??
      str("base_url") ??
      DEFAULT_SETTINGS.baseUrl
    ).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", bool("requireReason", DEFAULT_SETTINGS.requireReason)),
    captureInternalNotes: bool(
      "capture_internal_notes",
      bool("captureInternalNotes", DEFAULT_SETTINGS.captureInternalNotes),
    ),
    decisionFields: fields,
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    scopeTag: str("scope_tag") ?? str("scopeTag"),
    reasonPack: reasonPackFrom(raw.reason_pack ?? raw.reasonPack),
  };
}

/** Whether the app should watch this conversation at all based on scope tag. */
export function inScope(tags: readonly string[], settings: AppSettings): boolean {
  if (!settings.scopeTag) return true;
  return tags.includes(settings.scopeTag);
}

// ---------- Draft Detection & Origin Tagging ----------

export interface DraftDetector {
  /** Feed every composer value; returns a draft the first time one appears. */
  onComposer(text: string, now?: number, meta?: { origin?: DraftOrigin; isAi?: boolean }): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
}

export function createDraftDetector(opts: { minDraftChars: number; typingWindowMs?: number }): DraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;
  return {
    onComposer(text, now = Date.now(), meta) {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };
      if (draft) return null;
      if (meta?.origin) {
        draft = { text, origin: meta.origin, at: now };
        return draft;
      }
      if (meta?.isAi !== undefined) {
        draft = { text, origin: meta.isAi ? "ai" : "manual", at: now };
        return draft;
      }
      const grew = text.length - prev.text.length;
      // A jump of reply size in one change (or a reply-sized composer on first sight).
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;
      if (jump || first) {
        draft = { text, origin: "ai", at: now };
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

// ---------- Formatting & HTML Utilities ----------

/** Strips HTML markup from Intercom message bodies and normalizes whitespace. */
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

/** Converts numeric Unix seconds or date strings to an ISO datetime string. */
export function formatTimestamp(raw?: string | number | null): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "number") {
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^\d{9,12}$/.test(trimmed)) {
      return new Date(Number(trimmed) * 1000).toISOString();
    }
    return trimmed;
  }
  return null;
}

/** Maps Intercom author and part types to Overturn capture message roles. */
export function roleFromIntercom(
  partType?: string | null,
  authorRole?: string | null,
  isAgent?: boolean,
): CaptureMessage["role"] {
  if (partType === "note" || partType === "internalNote") return "note";
  if (isAgent || authorRole === "admin" || authorRole === "bot") return "agent";
  return "customer";
}

/** The conversation thread the teammate saw, oldest first, as capture context. */
export function contextFrom(conv: ConversationSnapshot): CaptureMessage[] {
  const parts = conversationParts(conv);
  return parts
    .filter((c) => (c.body ?? c.value ?? "").trim())
    .map((c) => ({
      role: roleFromIntercom(c.partType ?? c.type, c.authorRole, c.isAgent),
      author: c.authorEmail ?? c.authorName ?? (c.authorRole === "bot" ? "Fin" : null),
      content: stripHtml(c.body ?? c.value ?? ""),
      at: formatTimestamp(c.createdAt),
    }));
}

// ---------- Send Decision & Capture Payload ----------

export interface PendingSend {
  text: string;
  type?: "publicReply" | "internalNote" | string;
  partType?: "comment" | "note" | string;
  fields?: Record<string, unknown>;
}

export type SendDecision =
  | { action: "skip"; why: "no-draft" | "internal-note" | "empty" }
  | { action: "capture"; body: CaptureCreate; changed: boolean; changedFields: string[] }
  | { action: "need-reason"; changedFields: string[] };

/**
 * Returns the tag for a draft origin:
 * tag the run `draft:ai` only when the draft came from an assist,
 * `draft:manual` when the human typed it.
 * Guessing an origin we were not told is worse than `unknown`.
 */
export function draftTagFrom(origin: DraftOrigin): string | null {
  if (origin === "ai" || origin === "inserted" || origin === "recorded" || origin === "preloaded") {
    return "draft:ai";
  }
  if (origin === "manual") {
    return "draft:manual";
  }
  return null;
}

/**
 * Evaluates what to do when a reply is sent in Intercom.
 * Returns either a skip, a requirement for a reason code, or a complete CaptureCreate payload.
 */
export function decideOnSend(input: {
  conversation: ConversationSnapshot;
  draft: DraftState | null;
  draftFields?: Record<string, unknown>;
  send: PendingSend;
  reasonCode: string | null;
  reason?: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const { conversation, draft, send, settings } = input;
  const sentText = stripHtml(send.text);
  if (!sentText) return { action: "skip", why: "empty" };

  const isInternal = send.type === "internalNote" || send.partType === "note";
  if (isInternal && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  const hasFields = settings.decisionFields.length > 0;
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(hasFields ? { fields: input.draftFields ?? {} } : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(hasFields ? { fields: send.fields ?? {} } : {}),
  };
  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = (input.reason ?? "").trim();
  const reasonCode = input.reasonCode?.trim() || null;
  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const originTag = draftTagFrom(draft.origin);
  const tags: string[] = [...(originTag ? [originTag] : []), isInternal ? "internal-note" : "public-reply"];

  const customerIdentifier =
    conversation.customerEmail ??
    conversation.customerName ??
    conversation.requesterEmail ??
    conversation.requesterName ??
    null;

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
    tags,
    metadata: {
      customer: customerIdentifier,
    },
  };

  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

// ---------- UI & Canvas Presentation ----------

/** Short status line for the Intercom Inbox sidebar canvas. */
export function statusLine(
  d: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!d) return "Waiting for a draft";
  const words = d.text.trim() ? d.text.trim().split(/\s+/).length : 0;
  const from =
    {
      ai: "inserted",
      inserted: "inserted",
      manual: "marked by you",
      recorded: "recorded by your agent",
      preloaded: "found in the composer",
      unknown: "found in the composer",
    }[d.origin] ?? "inserted";
  return `Draft ${from} · ${words} words`;
}

/** The quick-pick reason options from the installed pack (support by default). */
export function quickReasons(settings: AppSettings): readonly ReasonCodeOption[] {
  return REASON_PACKS[settings.reasonPack];
}

export interface CanvasOptions {
  draft: DraftState | null;
  selectedReasonCode?: string | null;
  reasonNote?: string;
  settings: AppSettings;
  lastResult?: { kind: string; changed: boolean; dedup: boolean; caseTitle?: string | null } | null;
  error?: string | null;
  needsReason?: boolean;
}

/**
 * Builds an Intercom Canvas Kit response object for the Inbox Conversation Details surface.
 */
export function buildCanvas(opts: CanvasOptions): CanvasResponse {
  const { draft, settings, lastResult, error, needsReason } = opts;
  const components: CanvasComponent[] = [];

  // Status line
  components.push({
    type: "text",
    id: "status_text",
    text: statusLine(draft, lastResult ?? null),
    style: "header",
    align: "left",
  });

  if (needsReason) {
    components.push({
      type: "text",
      id: "need_reason_alert",
      text: "Please pick why you changed the reply before sending.",
      style: "error",
    });
  } else if (error) {
    components.push({
      type: "text",
      id: "error_text",
      text: error,
      style: "paragraph",
    });
  } else if (lastResult?.caseTitle) {
    components.push({
      type: "text",
      id: "case_note",
      text: `Case: ${lastResult.caseTitle}`,
      style: "paragraph",
    });
  }

  // Reason picker
  const reasons = quickReasons(settings);
  const options: CanvasDropdownOption[] = reasons.map((r) => ({
    type: "option",
    id: r.code,
    text: r.label,
  }));

  components.push({
    type: "dropdown",
    id: "reason_code",
    label: "Reason",
    options,
    value: opts.selectedReasonCode ?? null,
  });

  // Optional note
  components.push({
    type: "textarea",
    id: "reason_note",
    label: "Note (optional)",
    placeholder: "Anything else? Optional.",
    value: opts.reasonNote ?? "",
  });

  // Actions
  components.push({
    type: "button",
    id: "save_reason",
    label: "Save Reason",
    style: "primary",
    action: {
      type: "submit",
    },
  });

  if (!draft || draft.origin === "manual") {
    components.push({
      type: "button",
      id: "mark_draft",
      label: "Use current text as draft",
      style: "secondary",
      action: {
        type: "submit",
      },
    });
  }

  return {
    canvas: {
      content: {
        components,
      },
      stored_data: {
        draft: draft
          ? {
              text: draft.text,
              origin: draft.origin,
              at: draft.at,
              runId: draft.runId,
              model: draft.model,
            }
          : null,
        reasonCode: opts.selectedReasonCode ?? null,
        reasonNote: opts.reasonNote ?? "",
        lastResult: lastResult ?? null,
      },
    },
  };
}

/**
 * Sends capture to Overturn. Never throws and never blocks the send.
 */
export async function executeCapture(opts: {
  decision: SendDecision;
  settings: AppSettings;
  apiKey: string;
  fetchFn?: typeof fetch;
}): Promise<CaptureResult | null> {
  if (opts.decision.action !== "capture") return null;
  try {
    const f = opts.fetchFn ?? fetch;
    const res = await f(`${opts.settings.baseUrl}/v1/capture`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify(opts.decision.body),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as CaptureResult;
  } catch {
    return null;
  }
}

/**
 * Normalizes a raw Intercom conversation object (from API or Canvas Kit) into a ConversationSnapshot.
 */
export function conversationSnapshotFrom(
  raw: Record<string, unknown>,
  settings?: AppSettings,
): ConversationSnapshot {
  const id = (raw.id as string | number | undefined) ?? "";
  const source = (raw.source as Record<string, unknown> | undefined) ?? {};
  const sourceAuthor = (source.author as Record<string, unknown> | undefined) ?? {};
  const user = (raw.user as Record<string, unknown> | undefined) ?? {};

  const customerEmail =
    (user.email as string | undefined) ?? (sourceAuthor.email as string | undefined) ?? null;
  const customerName = (user.name as string | undefined) ?? (sourceAuthor.name as string | undefined) ?? null;

  const parts: ConversationPart[] = [];

  if (typeof source.body === "string" && source.body.trim()) {
    parts.push({
      id: source.id as string | number | undefined,
      body: source.body,
      partType: "comment",
      authorName: (sourceAuthor.name as string | undefined) ?? null,
      authorEmail: (sourceAuthor.email as string | undefined) ?? null,
      authorRole: (sourceAuthor.type as string | undefined) ?? "user",
      createdAt: (source.created_at as string | number | undefined) ?? null,
    });
  }

  const rawPartsObj = raw.conversation_parts as Record<string, unknown> | undefined;
  const rawPartsList = Array.isArray(raw.conversation_parts)
    ? raw.conversation_parts
    : Array.isArray(rawPartsObj?.conversation_parts)
      ? rawPartsObj.conversation_parts
      : Array.isArray(raw.parts)
        ? raw.parts
        : [];

  for (const p of rawPartsList as Array<Record<string, unknown>>) {
    const pAuthor = (p.author as Record<string, unknown> | undefined) ?? {};
    const body = (p.body as string | undefined) ?? (p.value as string | undefined) ?? "";
    if (!body.trim()) continue;
    parts.push({
      id: p.id as string | number | undefined,
      body,
      partType: (p.part_type as string | undefined) ?? (p.partType as string | undefined) ?? "comment",
      authorName: (pAuthor.name as string | undefined) ?? (p.authorName as string | undefined) ?? null,
      authorEmail: (pAuthor.email as string | undefined) ?? (p.authorEmail as string | undefined) ?? null,
      authorRole: (pAuthor.type as string | undefined) ?? (p.authorRole as string | undefined) ?? "admin",
      createdAt:
        (p.created_at as string | number | undefined) ?? (p.createdAt as string | number | undefined) ?? null,
    });
  }

  const rawCustom =
    (raw.custom_attributes as Record<string, unknown> | undefined) ??
    (raw.fields as Record<string, unknown> | undefined) ??
    {};
  const fields: Record<string, unknown> = {};
  if (settings && settings.decisionFields.length > 0) {
    for (const f of settings.decisionFields) {
      fields[f.label] = rawCustom[f.id] ?? rawCustom[f.label] ?? null;
    }
  } else {
    Object.assign(fields, rawCustom);
  }

  return {
    id,
    subject: (raw.subject as string | undefined) ?? (source.subject as string | undefined) ?? null,
    customerEmail,
    customerName,
    parts,
    fields,
    url: (raw.url as string | undefined) ?? `https://app.intercom.com/a/inbox/conversation/${id}`,
  };
}
