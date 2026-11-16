import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import { type AppSettings, type DraftOrigin, type DraftState, quickReasons, statusLine } from "./capture";

export interface TextComponent {
  type: "text";
  id?: string;
  text: string;
  style?: "header" | "paragraph" | "muted" | "error";
  align?: "left" | "center" | "right";
}

export interface DropdownOption {
  type: "option";
  id: string;
  text: string;
}

export interface DropdownComponent {
  type: "dropdown";
  id: string;
  label?: string;
  options: DropdownOption[];
  value?: string;
}

export interface TextareaComponent {
  type: "textarea";
  id: string;
  label?: string;
  placeholder?: string;
  value?: string;
  error?: boolean;
}

export interface ButtonComponent {
  type: "button";
  id: string;
  label: string;
  action: { type: "submit" };
  style?: "primary" | "secondary" | "link";
}

export type CanvasComponent = TextComponent | DropdownComponent | TextareaComponent | ButtonComponent;

export interface CanvasResponse {
  canvas: {
    content: { components: CanvasComponent[] };
    stored_data: Record<string, unknown>;
  };
}

export interface CaptureSummary {
  kind: string;
  changed: boolean;
  deduplicated: boolean;
  caseTitle?: string | null;
}

export interface StoredCanvasState {
  draft: DraftState | null;
  reasonCode: string | null;
  note: string;
  sentText: string;
}

export const COMPONENT = {
  markDraft: "mark_draft",
  capture: "capture",
  reset: "reset",
  reason: "reason",
  note: "note",
  sentText: "sent_text",
  draftText: "draft_text",
  draftOrigin: "draft_origin",
} as const;

export const ORIGIN_OPTIONS: ReadonlyArray<{ id: DraftOrigin; text: string }> = [
  { id: "ai", text: "An AI assist wrote it (e.g. Fin)" },
  { id: "manual", text: "I typed it" },
  { id: "unknown", text: "I am not sure" },
];

const originLabel: Record<DraftOrigin, string> = {
  ai: "AI draft",
  manual: "Typed by a person",
  unknown: "Origin not known",
};

export function storedFrom(state: StoredCanvasState): Record<string, unknown> {
  return {
    draft: state.draft
      ? {
          text: state.draft.text,
          origin: state.draft.origin,
          at: state.draft.at,
          ...(state.draft.runId ? { runId: state.draft.runId } : {}),
          ...(state.draft.model ? { model: state.draft.model } : {}),
        }
      : null,
    reasonCode: state.reasonCode,
    note: state.note,
    sentText: state.sentText,
  };
}

/** The Canvas Kit response for the current step. */
export function buildCanvas(input: {
  draft: DraftState | null;
  reasonCode: string | null;
  note?: string;
  sentText?: string;
  settings: AppSettings;
  error?: string | null;
  result?: CaptureSummary | null;
}): CanvasResponse {
  const { draft, settings } = input;
  const components: CanvasComponent[] = [];

  if (input.result) {
    components.push({
      type: "text",
      text: input.result.changed
        ? input.result.deduplicated
          ? "✅ Captured · already in the suite"
          : "✅ Captured · edit saved as a case"
        : "✅ Sent as drafted · approved",
      style: "paragraph",
    });
    if (input.result.caseTitle) {
      components.push({ type: "text", text: `Case: ${input.result.caseTitle}`, style: "muted" });
    }
    components.push({
      type: "button",
      id: COMPONENT.reset,
      label: "Done",
      action: { type: "submit" },
      style: "link",
    });
    return {
      canvas: {
        content: { components },
        stored_data: storedFrom({
          draft: null,
          reasonCode: null,
          note: "",
          sentText: "",
        }),
      },
    };
  }

  components.push({
    type: "text",
    text: statusLine(draft, null),
    style: draft ? "paragraph" : "muted",
  });
  if (draft) {
    components.push({ type: "text", text: originLabel[draft.origin], style: "muted" });
  }

  if (!draft) {
    components.push({
      type: "textarea",
      id: COMPONENT.draftText,
      label: "Draft under review",
      placeholder: "Paste the draft the AI or a teammate wrote.",
    });
    components.push({
      type: "dropdown",
      id: COMPONENT.draftOrigin,
      label: "Who wrote the draft?",
      options: ORIGIN_OPTIONS.map((o) => ({ type: "option", id: o.id, text: o.text })),
      value: "unknown",
    });
    components.push({
      type: "button",
      id: COMPONENT.markDraft,
      label: "Use this draft",
      action: { type: "submit" },
      style: "secondary",
    });
    if (input.error) components.push({ type: "text", text: input.error, style: "error" });
    return {
      canvas: {
        content: { components },
        stored_data: storedFrom({
          draft: null,
          reasonCode: input.reasonCode,
          note: input.note ?? "",
          sentText: input.sentText ?? "",
        }),
      },
    };
  }

  components.push({
    type: "dropdown",
    id: COMPONENT.reason,
    label: "Why did you change it?",
    options: quickReasons(settings).map((r) => ({ type: "option", id: r.code, text: r.label })),
    ...(input.reasonCode ? { value: input.reasonCode } : {}),
  });
  components.push({
    type: "textarea",
    id: COMPONENT.note,
    label: "Anything else? Optional.",
    placeholder: "One line on what changed.",
    ...(input.note ? { value: input.note } : {}),
  });
  components.push({
    type: "textarea",
    id: COMPONENT.sentText,
    label: "What went out",
    placeholder: "Leave empty if you sent the draft unchanged.",
    ...(input.sentText ? { value: input.sentText } : {}),
  });
  if (input.error) components.push({ type: "text", text: input.error, style: "error" });
  components.push({
    type: "button",
    id: COMPONENT.capture,
    label: "Capture this correction",
    action: { type: "submit" },
    style: "secondary",
  });
  components.push({
    type: "button",
    id: COMPONENT.reset,
    label: "Start over",
    action: { type: "submit" },
    style: "link",
  });

  return {
    canvas: {
      content: { components },
      stored_data: storedFrom({
        draft,
        reasonCode: input.reasonCode,
        note: input.note ?? "",
        sentText: input.sentText ?? "",
      }),
    },
  };
}

/** The result summary the Canvas Kit can show without leaking the whole API response. */
export function captureSummary(result: CaptureResult): CaptureSummary {
  return {
    kind: result.kind,
    changed: result.changed,
    deduplicated: result.deduplicated,
    caseTitle: result.case?.title ?? null,
  };
}

/** A Canvas Kit error canvas: useful text, never a thrown request. */
export function errorCanvas(settings: AppSettings, message: string): CanvasResponse {
  return buildCanvas({ draft: null, reasonCode: null, settings, error: message });
}

/** The capture body the handler posts; re-exported for the transport's tests. */
export type { CaptureCreate };
