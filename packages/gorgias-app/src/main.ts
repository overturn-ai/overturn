import type { CaptureCreate } from "@overturn-ai/shared";
import {
  type AppSettings,
  type DraftState,
  decideOnSend,
  findSentMessage,
  inScope,
  statusLine,
  stripHtml,
  type TicketSnapshot,
} from "./capture";

/**
 * The slice of the Gorgias ticket/message payloads this app uses, typed structurally the
 * way the Zendesk app types ZAF (developers.gorgias.com: HTTP integrations + widgets, and
 * the REST API ticket resource). Gorgias calls the app's endpoint on the integration
 * triggers — ticket-created, ticket-updated, ticket-message-created — and the sidebar
 * widget renders fields out of the JSON the endpoint answers with.
 */
export interface GorgiasMessage {
  id?: number;
  body_text?: string | null;
  body_html?: string | null;
  from_agent?: boolean;
  channel?: string;
  created_datetime?: string | null;
  sender?: { name?: string | null; email?: string | null } | null;
}

export interface GorgiasTicket {
  id: number;
  subject?: string | null;
  customer?: { email?: string | null; name?: string | null } | null;
  assignee_user?: { email?: string | null; name?: string | null } | null;
  tags?: Array<{ name: string }> | undefined;
  messages?: GorgiasMessage[] | undefined;
  custom_fields?:
    | Array<{ id?: number | string; name?: string; value?: unknown }>
    | Record<string, unknown>
    | undefined;
}

export interface GorgiasDeps {
  settings: AppSettings;
  /** Posts the capture to Overturn; the host server owns the API key and the fetch. */
  postCapture: (body: CaptureCreate) => Promise<{ kind: string; changed: boolean; deduplicated: boolean }>;
  /**
   * Where a ticket's draft lives between integration calls. The host backs this with its
   * own store; the handlers keep nothing between calls themselves.
   */
  drafts: {
    get(ticketId: string): Promise<DraftState | null>;
    set(ticketId: string, draft: DraftState | null): Promise<void>;
  };
  /** A drafting agent that recorded its run with the SDK is found by externalId (`gr:<ticket id>`). */
  findRecordedDraft?: (externalId: string) => Promise<DraftState | null>;
}

/** The Gorgias ticket payload, as a capture snapshot. */
export function snapshotFromTicket(ticket: GorgiasTicket, settings: AppSettings): TicketSnapshot {
  const raw: Record<string, unknown> = {};
  if (Array.isArray(ticket.custom_fields)) {
    for (const f of ticket.custom_fields) raw[String(f.id ?? f.name ?? "")] = f.value ?? null;
  } else if (ticket.custom_fields) {
    Object.assign(raw, ticket.custom_fields);
  }
  return {
    id: ticket.id,
    subject: ticket.subject ?? null,
    customerEmail: ticket.customer?.email ?? null,
    customerName: ticket.customer?.name ?? null,
    messages: (ticket.messages ?? []).map((m) => ({
      id: m.id,
      bodyText: m.body_text ?? null,
      bodyHtml: m.body_html ?? null,
      channel: m.channel ?? "",
      authorName: m.sender?.name ?? null,
      authorEmail: m.sender?.email ?? null,
      fromAgent: m.from_agent ?? false,
      createdAt: m.created_datetime ?? null,
    })),
    fields: Object.fromEntries(settings.decisionFields.map((f) => [f.label, raw[f.id] ?? null])),
    url: null,
  };
}

function outOfScope(ticket: GorgiasTicket, settings: AppSettings): boolean {
  if (!settings.scopeTag) return false;
  return !inScope(
    (ticket.tags ?? []).map((t) => t.name),
    settings,
  );
}

async function currentDraft(
  ticket: GorgiasTicket,
  deps: GorgiasDeps,
): Promise<{ draft: DraftState | null; stored: boolean }> {
  const stored = await deps.drafts.get(String(ticket.id));
  if (stored) return { draft: stored, stored: true };
  if (deps.findRecordedDraft) {
    const recorded = await deps.findRecordedDraft(`gr:${ticket.id}`);
    if (recorded) return { draft: recorded, stored: false };
  }
  return { draft: null, stored: false };
}

/** What the sidebar widget renders: the JSON the HTTP integration answers with. */
export interface WidgetData {
  status: string;
  state: "waiting" | "draft" | "out-of-scope";
  has_draft: boolean;
  draft_words: number;
}

export async function widgetData(ticket: GorgiasTicket, deps: GorgiasDeps): Promise<WidgetData> {
  const { settings } = deps;
  if (outOfScope(ticket, settings)) {
    return {
      status: `Not watching: no "${settings.scopeTag}" tag`,
      state: "out-of-scope",
      has_draft: false,
      draft_words: 0,
    };
  }
  const { draft } = await currentDraft(ticket, deps);
  return {
    status: statusLine(draft, null),
    state: draft ? "draft" : "waiting",
    has_draft: draft !== null,
    draft_words: draft ? draft.text.trim().split(/\s+/).length : 0,
  };
}

/**
 * Records the draft for a ticket. Called by whatever produced the draft — the AI drafting
 * integration, or the expert marking text by hand — with the origin it can honestly state;
 * an unstated origin is stored as "unknown" and the capture will carry no `draft:*` tag.
 */
export async function recordDraft(
  ticket: GorgiasTicket,
  input: { text: string; origin?: DraftState["origin"]; runId?: string; model?: string | null },
  deps: GorgiasDeps,
): Promise<DraftState | null> {
  const text = stripHtml(input.text);
  if (text.length < deps.settings.minDraftChars) return null;
  const draft: DraftState = {
    text,
    origin: input.origin ?? "unknown",
    ...(input.runId ? { runId: input.runId } : {}),
    model: input.model ?? null,
    at: Date.now(),
  };
  await deps.drafts.set(String(ticket.id), draft);
  return draft;
}

export type MessageOutcome =
  | { action: "ignored"; why: "out-of-scope" | "not-a-send" | "no-draft" | "internal-note" | "empty" }
  | { action: "need-reason"; changedFields: string[] }
  | { action: "captured"; changed: boolean; kind: string };

/**
 * The ticket-message-created trigger: when the newest ticket message is the expert's
 * public reply, capture it against the recorded draft. With `require_reason` on and no
 * reason yet, the capture is held — the draft stays stored and the host calls again with
 * the reason once the expert picks one (the send itself already happened; a capture must
 * never block it, and here it cannot).
 */
export async function handleMessageCreated(
  ticket: GorgiasTicket,
  deps: GorgiasDeps,
  opts: { reasonCode?: string | null; reason?: string } = {},
): Promise<MessageOutcome> {
  const { settings } = deps;
  if (outOfScope(ticket, settings)) return { action: "ignored", why: "out-of-scope" };
  const snapshot = snapshotFromTicket(ticket, settings);
  const newest = snapshot.messages[snapshot.messages.length - 1];
  if (newest?.channel === "internal-note") return { action: "ignored", why: "internal-note" };
  const sent = findSentMessage(snapshot);
  if (!sent || !newest || sent.messageId !== newest.id) return { action: "ignored", why: "not-a-send" };
  const { draft, stored } = await currentDraft(ticket, deps);
  if (!draft) return { action: "ignored", why: "no-draft" };
  const decision = decideOnSend({
    ticket: snapshot,
    draft,
    draftFields: snapshot.fields,
    send: { text: sent.text, type: "reply", fields: snapshot.fields },
    reasonCode: opts.reasonCode ?? null,
    reason: opts.reason ?? "",
    actor: sent.authorEmail ?? ticket.assignee_user?.email ?? null,
    settings,
    now: Date.now(),
  });
  if (decision.action === "skip") return { action: "ignored", why: decision.why };
  if (decision.action === "need-reason")
    return { action: "need-reason", changedFields: decision.changedFields };
  const result = await deps.postCapture(decision.body);
  if (stored) await deps.drafts.set(String(ticket.id), null);
  return { action: "captured", changed: result.changed, kind: result.kind };
}
