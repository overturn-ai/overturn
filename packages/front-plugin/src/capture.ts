import type { CaptureCreate } from "@overturn-ai/shared";
import { CLAIMS_AGENTS, normalizeCaptureText } from "@overturn-ai/shared/capture";
// The draft detector, the send decision and the status line are the Zendesk app's, reused as
// is (see docs/decisions.md: "the Front and Salesforce surfaces will reuse it"). This module only
// maps a Front conversation onto that shape and renames the payload for Front.
import {
  type AppSettings,
  createDraftDetector,
  type DraftDetector,
  type DraftState,
  decideOnSend,
  inScope,
  quickReasons,
  type SendDecision,
  statusLine,
  stripHtml,
  type TicketSnapshot,
  DEFAULT_SETTINGS as ZENDESK_DEFAULTS,
  settingsFrom as zendeskSettingsFrom,
} from "@overturn-ai/zendesk-app/src/capture";

export type { AppSettings, DraftDetector, DraftState, SendDecision };
export { createDraftDetector, inScope, quickReasons, statusLine, stripHtml };

/** The slices of Front's plugin SDK models this plugin reads (structurally compatible with the SDK's). */
export interface FrontRecipient {
  handle: string;
  name?: string | undefined;
}
export interface FrontCustomAttribute {
  name: string;
  value: unknown;
}
export interface FrontConversation {
  id: string;
  type?: string;
  subject?: string | undefined;
  recipient?: FrontRecipient | undefined;
  tags?: ReadonlyArray<{ name: string }>;
  customFieldAttributes?: ReadonlyArray<FrontCustomAttribute>;
  /** The open draft on this conversation, if any. */
  draftId?: string | undefined;
}
export interface FrontMessage {
  id: string;
  /** `inbound` from the customer, `outbound` from the team. */
  status: "inbound" | "outbound" | string;
  date?: Date | string | number | undefined;
  from?: FrontRecipient | undefined;
  content?: { body: string; type: "html" | "text" | string } | undefined;
}
export interface FrontComment {
  id: string;
  author?: { name?: string; email?: string } | undefined;
  content?: { body: string } | undefined;
  createdAt?: Date | string | number | undefined;
}

/** Front-side defaults: the claims pack and its reply workflow, as issue #20 asks. */
export const DEFAULT_SETTINGS: AppSettings = {
  ...ZENDESK_DEFAULTS,
  agent: CLAIMS_AGENTS.reply,
  reasonPack: "claims",
};

/**
 * Settings come from the query string of the plugin URL the admin enters in Front
 * (`https://host/overturn-front/?reason_pack=claims&require_reason=true`), with the same names
 * as the Zendesk app. The API key is never one of them: it lives in the Front app's Server
 * credentials and is attached by `relayHttp` (see README).
 */
export function settingsFrom(raw: Record<string, unknown>): AppSettings {
  const pack = typeof raw.reason_pack === "string" && raw.reason_pack.trim() ? raw.reason_pack : "claims";
  const parsed = zendeskSettingsFrom({ ...raw, reason_pack: pack });
  const agentSet = typeof raw.agent === "string" && raw.agent.trim() !== "";
  return {
    ...parsed,
    agent: agentSet
      ? parsed.agent
      : parsed.reasonPack === "claims"
        ? CLAIMS_AGENTS.reply
        : ZENDESK_DEFAULTS.agent,
  };
}

/** `URLSearchParams` → the raw settings record `settingsFrom` reads. */
export function settingsFromQuery(search: string): AppSettings {
  const raw: Record<string, string> = {};
  new URLSearchParams(search).forEach((v, k) => {
    raw[k] = v;
  });
  return settingsFrom(raw);
}

export function externalIdFor(conversationId: string): string {
  return `fr:${conversationId}`;
}

/** Front message and comment bodies: HTML or plain text (comments are markdown). */
export function bodyText(content: { body: string; type?: string } | undefined): string {
  if (!content?.body) return "";
  return content.type === "html" ? stripHtml(content.body) : normalizeCaptureText(content.body);
}

function iso(d: Date | string | number | undefined): string | null {
  if (d === undefined || d === null) return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The conversation's custom fields the admin chose as decision fields, by label. */
export function decisionFieldsFrom(
  conversation: FrontConversation,
  settings: AppSettings,
): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  const attrs = conversation.customFieldAttributes ?? [];
  return Object.fromEntries(
    settings.decisionFields.map((f) => {
      const hit = attrs.find((a) => a.name === f.id || a.name.toLowerCase() === f.id.toLowerCase());
      return [f.label, hit?.value ?? null];
    }),
  );
}

/**
 * A Front conversation as the snapshot the Zendesk logic reads: messages (inbound → customer,
 * outbound → agent) and teammate comments (→ note), oldest first. Read only after a draft exists.
 */
export function snapshotFrom(input: {
  conversation: FrontConversation;
  messages: readonly FrontMessage[];
  comments?: readonly FrontComment[];
  settings: AppSettings;
  url?: string | null;
}): TicketSnapshot {
  const { conversation } = input;
  const items: Array<TicketSnapshot["comments"][number] & { sortAt: number }> = [];
  for (const m of input.messages) {
    const at = iso(m.date);
    items.push({
      id: m.id,
      value: bodyText(m.content),
      type: "publicReply",
      authorName: m.from?.name ?? null,
      authorEmail: m.from?.handle ?? null,
      isAgent: m.status === "outbound",
      createdAt: at,
      sortAt: at ? Date.parse(at) : 0,
    });
  }
  for (const c of input.comments ?? []) {
    const at = iso(c.createdAt);
    items.push({
      id: c.id,
      value: bodyText(c.content ? { body: c.content.body, type: "text" } : undefined),
      type: "internalNote",
      authorName: c.author?.name ?? null,
      authorEmail: c.author?.email ?? null,
      isAgent: true,
      createdAt: at,
      sortAt: at ? Date.parse(at) : 0,
    });
  }
  // Stable sort: items without a date keep their place relative to each other.
  items.sort((a, b) => a.sortAt - b.sortAt);
  return {
    id: conversation.id,
    subject: conversation.subject ?? null,
    requesterEmail: conversation.recipient?.handle ?? null,
    requesterName: conversation.recipient?.name ?? null,
    comments: items.map(({ sortAt: _sortAt, ...c }) => c),
    fields: decisionFieldsFrom(conversation, input.settings),
    url: input.url ?? null,
  };
}

/**
 * The message the teammate just sent: the newest outbound message that was not in the
 * conversation when the draft appeared. Front's SDK has no send event, so a send is inferred
 * from the draft closing and this message appearing (it can lag behind "Undo send").
 */
export function findSentMessage(
  knownIds: ReadonlySet<string>,
  messages: readonly FrontMessage[],
): FrontMessage | null {
  let found: FrontMessage | null = null;
  for (const m of messages) {
    if (m.status !== "outbound" || knownIds.has(m.id)) continue;
    if (!found) {
      found = m;
      continue;
    }
    const a = iso(found.date);
    const b = iso(m.date);
    // Later in the list wins on a tie or a missing date (Front lists oldest first).
    if (!a || !b || Date.parse(b) >= Date.parse(a)) found = m;
  }
  return found;
}

/** Whether the composer text differs from the draft, as the capture diff will see it. */
export function composerChanged(draft: DraftState | null, composerText: string): boolean {
  if (!draft) return false;
  return stripHtml(draft.text) !== stripHtml(composerText);
}

/**
 * What to do once the teammate has sent: the Zendesk decision on the mapped snapshot, with the
 * payload renamed for Front (`source: "front"`, `externalId: "fr:<conversation id>"`).
 */
export function decideOnFrontSend(input: {
  conversation: FrontConversation;
  snapshot: TicketSnapshot;
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  /** The sent message body (or composer text) as Front returns it. */
  sentText: string;
  reasonCode: string | null;
  reason: string;
  actor: string | null;
  settings: AppSettings;
  now?: number;
}): SendDecision {
  const decision = decideOnSend({
    ticket: input.snapshot,
    draft: input.draft,
    draftFields: input.draftFields,
    send: { text: input.sentText, type: "publicReply", fields: input.snapshot.fields },
    reasonCode: input.reasonCode,
    reason: input.reason,
    actor: input.actor,
    settings: input.settings,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  if (decision.action !== "capture") return decision;
  const draftTag = (decision.body.tags ?? []).find((t) => t.startsWith("draft:"));
  const body: CaptureCreate = {
    ...decision.body,
    source: "front",
    externalId: externalIdFor(input.conversation.id),
    tags: [
      ...(draftTag ? [draftTag] : []),
      "reply",
      ...(input.conversation.type ? [`channel:${input.conversation.type}`] : []),
    ],
    metadata: {
      ...(decision.body.metadata ?? {}),
      conversationType: input.conversation.type ?? null,
    },
  };
  return { ...decision, body };
}
