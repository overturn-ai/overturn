import type { CaptureCreate } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  type DraftState,
  decideOnSend,
  findAiDraft,
  findSentReply,
  inScope,
  quickReasons,
  statusLine,
  stripHtml,
} from "./capture";

/**
 * The slice of the Canvas Kit payloads this app uses, typed structurally the way the
 * Zendesk app types ZAF (developers.intercom.com/docs/canvas-kit). Intercom POSTs an
 * initialize request when the app is added to the conversation details or the teammate
 * switches conversations, and a submit request when a component with a submit action is
 * used; both carry the conversation, and the submit adds `component_id`, `input_values`
 * and the `current_canvas` (whose `stored_data` is where the draft state rides between
 * requests — Canvas Kit handlers are stateless).
 */
export interface CanvasKitAuthor {
  type: string;
  id?: string;
  name?: string | null;
  email?: string | null;
}

export interface CanvasKitPart {
  id: string;
  part_type: string;
  body?: string | null;
  created_at?: number;
  author?: CanvasKitAuthor;
}

export interface CanvasKitConversation {
  id: string;
  title?: string | null;
  source?:
    | { body?: string | null; subject?: string | null; created_at?: number; author?: CanvasKitAuthor }
    | undefined;
  conversation_parts?: { conversation_parts?: CanvasKitPart[] } | undefined;
  tags?: { tags?: Array<{ name: string }> } | undefined;
  custom_attributes?: Record<string, unknown> | undefined;
}

export interface CanvasKitRequest {
  workspace_id: string;
  admin?: { id?: string; email?: string; name?: string } | undefined;
  conversation?: CanvasKitConversation | undefined;
  contact?: { id?: string; email?: string | null; name?: string | null } | undefined;
  customer?: { id?: string; email?: string | null; name?: string | null } | undefined;
}

export interface CanvasKitSubmitRequest extends CanvasKitRequest {
  component_id: string;
  input_values?: Record<string, string> | undefined;
  current_canvas?: { stored_data?: Record<string, unknown> | undefined } | undefined;
}

/** The slice of the Canvas Kit component model this app renders. */
export type CanvasComponent =
  | { type: "text"; text: string; style?: "header" | "paragraph" | "muted" }
  | { type: "input"; id: string; label: string; placeholder?: string }
  | {
      type: "dropdown";
      id: string;
      label: string;
      options: Array<{ type: "option"; id: string; text: string }>;
    }
  | { type: "button"; id: string; label: string; style?: "primary" | "secondary"; action: { type: "submit" } }
  | { type: "divider" };

export interface CanvasResponse {
  canvas: {
    content: { components: CanvasComponent[] };
    stored_data?: Record<string, string>;
  };
}

export interface CanvasDeps {
  settings: AppSettings;
  /** Posts the capture to Overturn; the host server owns the API key and the fetch. */
  postCapture: (body: CaptureCreate) => Promise<{ kind: string; changed: boolean; deduplicated: boolean }>;
}

function epochToIso(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return null;
  const d = new Date(seconds * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The conversation in a Canvas Kit request, as a capture snapshot. Null outside a conversation. */
export function snapshotFrom(req: CanvasKitRequest, settings: AppSettings): ConversationSnapshot | null {
  const conv = req.conversation;
  if (!conv) return null;
  const parts: ConversationSnapshot["parts"] = [];
  const source = conv.source;
  if (source && (source.body ?? "").trim()) {
    parts.push({
      body: source.body ?? "",
      partType: "comment",
      authorName: source.author?.name ?? null,
      authorEmail: source.author?.email ?? null,
      authorType: source.author?.type ?? null,
      createdAt: epochToIso(source.created_at),
    });
  }
  for (const p of conv.conversation_parts?.conversation_parts ?? []) {
    parts.push({
      id: p.id,
      body: p.body ?? "",
      partType: p.part_type,
      authorName: p.author?.name ?? null,
      authorEmail: p.author?.email ?? null,
      authorType: p.author?.type ?? null,
      createdAt: epochToIso(p.created_at),
    });
  }
  const contact = req.contact ?? req.customer;
  const attrs = conv.custom_attributes ?? {};
  return {
    id: conv.id,
    subject: conv.title ?? source?.subject ?? null,
    contactEmail: contact?.email ?? null,
    contactName: contact?.name ?? null,
    parts,
    fields: Object.fromEntries(settings.decisionFields.map((f) => [f.label, attrs[f.id] ?? null])),
    url: null,
  };
}

function draftToStored(draft: DraftState): string {
  return JSON.stringify(draft);
}

/** The draft a previous canvas stored, read back defensively; an unstated origin stays unknown. */
export function draftFromStored(raw: unknown): DraftState | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<DraftState>;
    if (typeof v.text !== "string" || !v.text) return null;
    const origin =
      v.origin === "ai" || v.origin === "manual" || v.origin === "recorded" ? v.origin : "unknown";
    return {
      text: v.text,
      origin,
      ...(typeof v.partId === "string" ? { partId: v.partId } : {}),
      ...(typeof v.runId === "string" ? { runId: v.runId } : {}),
      model: typeof v.model === "string" ? v.model : null,
      at: typeof v.at === "number" ? v.at : Date.now(),
    };
  } catch {
    return null;
  }
}

function panel(opts: {
  status: string;
  draft: DraftState | null;
  settings: AppSettings;
  notice?: string;
}): CanvasResponse {
  const components: CanvasComponent[] = [{ type: "text", text: opts.status, style: "header" }];
  if (opts.notice) components.push({ type: "text", text: opts.notice, style: "muted" });
  if (opts.draft) {
    components.push({ type: "divider" });
    components.push({
      type: "dropdown",
      id: "reason_code",
      label: "Why did you change it?",
      options: [
        { type: "option", id: "none", text: "No reason picked" },
        ...quickReasons(opts.settings).map((r) => ({ type: "option" as const, id: r.code, text: r.label })),
      ],
    });
    components.push({ type: "input", id: "reason_note", label: "Note (optional)" });
    components.push({
      type: "button",
      id: "capture",
      label: "Save capture",
      style: "primary",
      action: { type: "submit" },
    });
  } else {
    components.push({
      type: "input",
      id: "draft_text",
      label: "Or mark a draft by hand: paste the reply text that was drafted",
    });
    components.push({
      type: "button",
      id: "mark_draft",
      label: "Use this text as the draft",
      style: "secondary",
      action: { type: "submit" },
    });
  }
  return {
    canvas: {
      content: { components },
      ...(opts.draft ? { stored_data: { overturn_draft: draftToStored(opts.draft) } } : {}),
    },
  };
}

function outOfScope(req: CanvasKitRequest, settings: AppSettings): boolean {
  if (!settings.scopeTag) return false;
  const tags = req.conversation?.tags?.tags?.map((t) => t.name) ?? [];
  return !inScope(tags, settings);
}

/** The initialize flow: Intercom asks what to show when the app opens on a conversation. */
export function handleInitialize(req: CanvasKitRequest, deps: CanvasDeps): CanvasResponse {
  const { settings } = deps;
  const snapshot = snapshotFrom(req, settings);
  if (!snapshot) {
    return panel({ status: "Open a conversation to capture.", draft: null, settings });
  }
  if (outOfScope(req, settings)) {
    return panel({
      status: `Not watching: no "${settings.scopeTag}" tag`,
      draft: null,
      settings,
    });
  }
  const draft = findAiDraft(snapshot);
  return panel({ status: statusLine(draft, null), draft, settings });
}

/** The submit flow: a button on the canvas was used. */
export async function handleSubmit(req: CanvasKitSubmitRequest, deps: CanvasDeps): Promise<CanvasResponse> {
  const { settings } = deps;
  const snapshot = snapshotFrom(req, settings);
  if (!snapshot) {
    return panel({ status: "Open a conversation to capture.", draft: null, settings });
  }
  if (outOfScope(req, settings)) {
    return panel({ status: `Not watching: no "${settings.scopeTag}" tag`, draft: null, settings });
  }
  const stored = draftFromStored(req.current_canvas?.stored_data?.overturn_draft);
  const draft = stored ?? findAiDraft(snapshot);

  if (req.component_id === "mark_draft") {
    const text = stripHtml(req.input_values?.draft_text ?? "");
    if (text.length < settings.minDraftChars) {
      return panel({
        status: statusLine(draft, null),
        draft,
        settings,
        notice: `That text is too short to be a draft (under ${settings.minDraftChars} characters).`,
      });
    }
    const marked: DraftState = { text, origin: "manual", at: Date.now() };
    return panel({ status: statusLine(marked, null), draft: marked, settings });
  }

  if (req.component_id === "capture") {
    if (!draft) {
      return panel({ status: statusLine(null, null), draft: null, settings });
    }
    const sent = findSentReply(snapshot, draft);
    if (!sent) {
      return panel({
        status: statusLine(draft, null),
        draft,
        settings,
        notice:
          "No reply from you on this conversation yet — send it in Intercom first, then save the capture.",
      });
    }
    const picked = req.input_values?.reason_code;
    const decision = decideOnSend({
      conversation: snapshot,
      draft,
      draftFields: snapshot.fields,
      send: { text: sent.text, type: "reply", fields: snapshot.fields },
      reasonCode: picked && picked !== "none" ? picked : null,
      reason: req.input_values?.reason_note ?? "",
      actor: req.admin?.email ?? null,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") {
      return panel({ status: statusLine(draft, null), draft, settings, notice: "Nothing to capture." });
    }
    if (decision.action === "need-reason") {
      return panel({
        status: statusLine(draft, null),
        draft,
        settings,
        notice: "Pick why you changed it above — the capture is held until you do.",
      });
    }
    try {
      const result = await deps.postCapture(decision.body);
      return panel({
        status: statusLine(null, {
          kind: result.kind,
          changed: result.changed,
          dedup: result.deduplicated,
        }),
        draft: null,
        settings,
      });
    } catch {
      // Never block the agent's work on our failure; say so in the panel.
      return panel({
        status: statusLine(draft, null),
        draft,
        settings,
        notice: "Overturn could not save this correction (network).",
      });
    }
  }

  return panel({ status: statusLine(draft, null), draft, settings });
}
