import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  buildCanvas,
  type CanvasResponse,
  COMPONENT,
  captureSummary,
  errorCanvas,
  type StoredCanvasState,
} from "./canvas";
import {
  type AppSettings,
  type DraftOriginSignals,
  type DraftState,
  decideOnSend,
  draftOriginFrom,
  type IntercomConversation,
} from "./capture";

export interface CaptureTransport {
  capture(body: CaptureCreate): Promise<CaptureResult>;
}

export interface CanvasDeps {
  settings: AppSettings;
  capture: CaptureTransport;
  now?: () => number;
  logger?: Pick<Console, "error">;
}

export type StoredRequestState = StoredCanvasState;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseConversation(value: unknown): IntercomConversation | null {
  const conv = record(value);
  const id = conv.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  return value as IntercomConversation;
}

function readStored(body: Record<string, unknown>): StoredRequestState {
  const direct = record(body.stored_data);
  const current = record(record(body.current_canvas).stored_data);
  const stored = Object.keys(direct).length > 0 ? direct : current;
  const draftRaw = record(stored.draft);
  const draftText = text(draftRaw.text);
  const originRaw = draftRaw.origin;
  const origin = draftOriginFrom({ origin: originRaw });
  const at = numeric(draftRaw.at);
  const runId = optionalText(draftRaw.runId);
  const model = optionalText(draftRaw.model);
  const draft: DraftState | null = draftText
    ? {
        text: draftText,
        origin,
        at: at ?? Date.now(),
        ...(runId ? { runId } : {}),
        ...(model ? { model } : {}),
      }
    : null;
  return {
    draft,
    reasonCode: optionalText(stored.reasonCode),
    note: text(stored.note),
    sentText: text(stored.sentText),
  };
}

function signalsFrom(source: Record<string, unknown>, nested: Record<string, unknown>): DraftOriginSignals {
  const author = record(nested.author);
  return {
    origin: nested.origin ?? source.draft_origin ?? source.origin,
    assist: source.assist ?? source.from_fin ?? source.is_fin_draft,
    authorType: nested.authorType ?? nested.author_type ?? author.type,
  };
}

function stateFrom(
  value: unknown,
  signals: DraftOriginSignals,
  settings: AppSettings,
  now: number,
  force = false,
): DraftState | null {
  const source = record(value);
  const draftText = typeof value === "string" ? value : text(source.text) || text(source.composer_text);
  if (!draftText.trim()) return null;
  if (!force && draftText.length < settings.minDraftChars) return null;
  const runId = optionalText(source.runId) ?? optionalText(source.run_id);
  const model = optionalText(source.model);
  return {
    text: draftText,
    origin: draftOriginFrom(signals),
    at: numeric(source.at) ?? now,
    ...(runId ? { runId } : {}),
    ...(model ? { model } : {}),
  };
}

function initializeDraft(
  body: Record<string, unknown>,
  stored: StoredRequestState,
  settings: AppSettings,
  now: number,
): DraftState | null {
  const draftRaw = body.draft;
  const nested = record(draftRaw);
  const signals = signalsFrom(body, nested);
  if (draftRaw !== undefined && draftRaw !== null) {
    const fromBody = stateFrom(draftRaw, signals, settings, now);
    if (fromBody) return fromBody;
  }
  const composer = body.composer;
  if (composer !== undefined && composer !== null) {
    const fromComposer = stateFrom(composer, signalsFrom(body, record(composer)), settings, now);
    if (fromComposer) return fromComposer;
  }
  const composerText = text(body.composer_text) || text(body.draft_text);
  if (composerText) return stateFrom(composerText, signals, settings, now);
  return stored.draft;
}

function actorFrom(body: Record<string, unknown>): string | null {
  const admin = record(body.admin);
  return (
    optionalText(admin.email) ??
    optionalText(admin.name) ??
    optionalText(record(body.teammate).email) ??
    optionalText(body.actor)
  );
}

/**
 * The Canvas Kit request handler. It returns a canvas for every request and never throws at the
 * caller: a failed capture is logged and shown as muted text, so Intercom's own send is untouched.
 */
export async function handleCanvasRequest(body: unknown, deps: CanvasDeps): Promise<CanvasResponse> {
  const settings = deps.settings;
  const now = deps.now?.() ?? Date.now();
  const req = record(body);
  const conversation = parseConversation(req.conversation);
  if (!conversation) {
    return errorCanvas(settings, "Open this app from an Intercom conversation to capture a correction.");
  }

  const stored = readStored(req);
  const inputs = record(req.input_values);
  const component = optionalText(req.component_id);

  if (!component) {
    const draft = initializeDraft(req, stored, settings, now);
    return buildCanvas({
      draft,
      reasonCode: stored.reasonCode,
      note: stored.note,
      sentText: stored.sentText,
      settings,
    });
  }

  if (component === COMPONENT.reset) {
    return buildCanvas({ draft: null, reasonCode: null, settings });
  }

  if (component === COMPONENT.markDraft) {
    const draftText = text(inputs[COMPONENT.draftText]) || stored.draft?.text || "";
    const signals = { origin: inputs[COMPONENT.draftOrigin] };
    const draft = stateFrom(draftText, signals, settings, now, true);
    if (!draft) {
      return buildCanvas({
        draft: null,
        reasonCode: null,
        settings,
        error: "Paste the draft you are reviewing first.",
      });
    }
    return buildCanvas({ draft, reasonCode: null, settings });
  }

  if (component !== COMPONENT.capture && component !== "submit_capture") {
    return buildCanvas({
      draft: stored.draft,
      reasonCode: stored.reasonCode,
      note: stored.note,
      sentText: stored.sentText,
      settings,
    });
  }

  // Draft: prefer the stored canvas state, then an explicit draft, then the text the teammate pasted.
  const explicit = req.draft;
  const explicitDraft = explicit
    ? stateFrom(explicit, signalsFrom(req, record(explicit)), settings, now, true)
    : null;
  const pastedDraft = stateFrom(
    text(inputs[COMPONENT.draftText]),
    { origin: inputs[COMPONENT.draftOrigin] },
    settings,
    now,
    true,
  );
  const draft = stored.draft ?? explicitDraft ?? pastedDraft;
  const sentText = text(inputs[COMPONENT.sentText]) || stored.sentText || draft?.text || "";
  const reasonCode = optionalText(inputs[COMPONENT.reason]) ?? stored.reasonCode;
  const note = text(inputs[COMPONENT.note]) || stored.note;

  const decision = decideOnSend({
    conversation,
    draft,
    send: { text: sentText },
    reasonCode,
    reason: note,
    actor: actorFrom(req),
    settings,
    now,
  });

  if (decision.action === "skip") {
    return buildCanvas({
      draft,
      reasonCode,
      note,
      sentText,
      settings,
      error: "No draft to capture yet. Paste the draft under review first.",
    });
  }

  if (decision.action === "need-reason") {
    return buildCanvas({
      draft,
      reasonCode,
      note,
      sentText,
      settings,
      // The Intercom send is not gated by this app; only the capture waits for a reason.
      error: "Pick why you changed it before capturing this correction.",
    });
  }

  try {
    const result = await deps.capture.capture(decision.body);
    return buildCanvas({
      draft,
      reasonCode,
      note,
      sentText,
      settings,
      result: captureSummary(result),
    });
  } catch (error) {
    deps.logger?.error("intercom capture failed", error);
    return buildCanvas({
      draft,
      reasonCode,
      note,
      sentText,
      settings,
      error: "Overturn could not save this correction. The send was not blocked.",
    });
  }
}
