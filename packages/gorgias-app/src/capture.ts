import {
  type AppSettings,
  type CaptureAnswer,
  type CaptureCreate,
  type CaptureMessage,
  DEFAULT_SETTINGS,
  type DraftState,
  diffCaptureAnswers,
  type GorgiasTicketSnapshot,
  normalizeCaptureText,
  type PendingSend,
  REASON_PACKS,
  type SendDecision,
} from "./types.js";

/**
 * Strips HTML formatting from Gorgias rich-text message bodies.
 */
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

/**
 * Parses settings from Gorgias App widget configuration.
 */
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
  const pack = str("reason_pack");

  return {
    baseUrl: (str("overturn_base_url") ?? DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ""),
    agent: str("agent") ?? DEFAULT_SETTINGS.agent,
    requireReason: bool("require_reason", DEFAULT_SETTINGS.requireReason),
    captureInternalNotes: bool("capture_internal_notes", DEFAULT_SETTINGS.captureInternalNotes),
    decisionFields: fields,
    includeOrderContext: bool("include_order_context", DEFAULT_SETTINGS.includeOrderContext),
    minDraftChars: Number.isFinite(min) && min > 0 ? min : DEFAULT_SETTINGS.minDraftChars,
    reasonPack: pack === "claims" ? "claims" : "support",
  };
}

export interface GorgiasDraftDetector {
  onReplyBox(text: string, isAiAssist?: boolean, now?: number): DraftState | null;
  current(): DraftState | null;
  set(d: DraftState | null): void;
  reset(): void;
}

/**
 * Creates draft detector for Gorgias ticket reply box.
 */
export function createGorgiasDraftDetector(opts: {
  minDraftChars: number;
  typingWindowMs?: number;
}): GorgiasDraftDetector {
  const window = opts.typingWindowMs ?? 1500;
  let draft: DraftState | null = null;
  let last = { text: "", at: 0 };
  let seen = false;

  return {
    onReplyBox(text: string, isAiAssist = false, now = Date.now()): DraftState | null {
      const prev = last;
      const firstSight = !seen;
      seen = true;
      last = { text, at: now };

      if (draft) return null;

      const cleanText = text.trim();
      const words = cleanText ? cleanText.split(/\s+/).length : 0;

      // 1. Explicit AI assist in Gorgias
      if (isAiAssist && cleanText.length >= opts.minDraftChars) {
        draft = {
          text,
          origin: "ai_assist",
          at: now,
          wordCount: words,
        };
        return draft;
      }

      const grew = text.length - prev.text.length;
      const jump =
        grew >= opts.minDraftChars && (prev.text.length < opts.minDraftChars / 2 || now - prev.at > window);
      const first = firstSight && text.length >= opts.minDraftChars;

      if (jump || first) {
        draft = {
          text,
          origin: first ? "preloaded" : "inserted",
          at: now,
          wordCount: words,
        };
        return draft;
      }

      return null;
    },
    current: () => draft,
    set: (d) => {
      draft = d;
    },
    reset: () => {
      draft = null;
      last = { text: "", at: 0 };
      seen = false;
    },
  };
}

/**
 * Converts Gorgias ticket messages into standardized Overturn context messages.
 */
export function contextFrom(ticket: GorgiasTicketSnapshot): CaptureMessage[] {
  return ticket.messages
    .filter((m) => (m.body_text || m.body_html || "").trim())
    .map((m) => {
      let role: CaptureMessage["role"] = "customer";
      if (m.channel === "internal-note") {
        role = "note";
      } else if (m.from_agent) {
        role = "agent";
      }

      const content = m.body_text ? normalizeCaptureText(m.body_text) : stripHtml(m.body_html || "");

      return {
        role,
        author: m.sender?.email ?? m.sender?.name ?? null,
        content,
        at: m.created_datetime ?? null,
      };
    });
}

/**
 * Extracts order context fields relevant for Gorgias e-commerce workflows.
 */
export function extractOrderFields(
  ticket: GorgiasTicketSnapshot,
  settings: AppSettings,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  if (settings.includeOrderContext && ticket.orderContext) {
    const oc = ticket.orderContext;
    if (oc.orderId) fields.order_id = oc.orderId;
    if (oc.orderNumber) fields.order_number = oc.orderNumber;
    if (oc.totalPrice !== undefined && oc.totalPrice !== null) fields.order_total = oc.totalPrice;
    if (oc.financialStatus) fields.financial_status = oc.financialStatus;
    if (oc.fulfillmentStatus) fields.fulfillment_status = oc.fulfillmentStatus;
    if (oc.trackingNumber) fields.tracking_number = oc.trackingNumber;
  }

  // Include custom decision fields configured by admin
  for (const df of settings.decisionFields) {
    if (ticket.customFields && df.id in ticket.customFields) {
      fields[df.label] = ticket.customFields[df.id];
    }
  }

  return fields;
}

/**
 * Evaluates ticket submission in Gorgias reply box.
 * Never blocks the send: returns SendDecision with action 'skip', 'need-reason', or 'capture'.
 */
export function decideOnSend(input: {
  ticket: GorgiasTicketSnapshot;
  draft: DraftState | null;
  draftFields?: Record<string, unknown>;
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
  if (send.isInternalNote && !settings.captureInternalNotes) {
    return { action: "skip", why: "internal-note" };
  }
  if (!draft) return { action: "skip", why: "no-draft" };

  const orderFields = extractOrderFields(ticket, settings);
  const draftAnswer: CaptureAnswer = {
    text: stripHtml(draft.text),
    ...(Object.keys(orderFields).length > 0
      ? { fields: { ...orderFields, ...(input.draftFields ?? {}) } }
      : {}),
  };
  const sentAnswer: CaptureAnswer = {
    text: sentText,
    ...(Object.keys(orderFields).length > 0 ? { fields: { ...orderFields, ...(send.fields ?? {}) } } : {}),
  };

  const diff = diffCaptureAnswers(draftAnswer, sentAnswer);
  const reason = input.reason.trim();
  const reasonCode = input.reasonCode?.trim() || null;

  if (diff.changed && settings.requireReason && !reasonCode) {
    return { action: "need-reason", changedFields: diff.changedFields };
  }

  const originTag = draft.origin === "ai_assist" ? "draft:ai" : "draft:manual";

  const body: CaptureCreate = {
    source: "gorgias",
    externalId: `gr:${ticket.id}`,
    agent: settings.agent,
    actor: input.actor,
    subject: ticket.subject,
    context: contextFrom(ticket),
    draft: draftAnswer,
    sent: sentAnswer,
    reason: reason || null,
    reasonCode: diff.changed ? reasonCode : null,
    secondsToSend: Math.max(0, Math.round(((input.now ?? Date.now()) - draft.at) / 100) / 10),
    draftRunId: draft.runId ?? null,
    draftModel: draft.model ?? null,
    url: ticket.url,
    tags: [originTag, send.isInternalNote ? "internal-note" : "public-reply"],
    metadata: {
      customer: ticket.customerEmail ?? ticket.customerName ?? null,
      orderNumber: ticket.orderContext?.orderNumber ?? null,
    },
  };

  return { action: "capture", body, changed: diff.changed, changedFields: diff.changedFields };
}

/**
 * Returns formatted status line for the Gorgias ticket sidebar widget:
 * Shows 'Draft inserted · N words' or state.
 */
export function statusLine(
  draft: DraftState | null,
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null,
): string {
  if (lastResult) {
    if (!lastResult.changed) return "Sent as drafted · approved";
    return lastResult.dedup ? "Captured · already in the suite" : "Captured · edit saved as a case";
  }
  if (!draft) return "Waiting for a draft";

  const words = draft.wordCount || draft.text.trim().split(/\s+/).length;
  const from =
    draft.origin === "ai_assist" ? "from AI assist" : draft.origin === "manual" ? "typed by you" : "inserted";

  return `Draft ${from} · ${words} words`;
}

/**
 * Quick-pick reasons for Gorgias e-commerce (support codes by default).
 */
export function quickReasons(settings: AppSettings) {
  return REASON_PACKS[settings.reasonPack];
}
