import { type AppSettings, type DraftState, quickReasons, statusLine } from "./capture";

/** The slice of Canvas Kit this app renders. */
export type Component =
  | { type: "text"; id: string; text: string; style?: "header" | "muted" | "paragraph" | "error" }
  | { type: "textarea"; id: string; label: string; value?: string; placeholder?: string }
  | {
      type: "single-select";
      id: string;
      label: string;
      value?: string;
      options: Array<{ type: "option"; id: string; text: string }>;
    }
  | { type: "button"; id: string; label: string; style: "primary"; action: { type: "submit" } };

export interface CanvasResponse {
  canvas: {
    content: { components: Component[] };
    /** Echoed back by Intercom on the next request. */
    stored_data?: Record<string, unknown>;
  };
}

export const CAPTURE_BUTTON_ID = "capture";

export const ORIGIN_OPTIONS = [
  { type: "option", id: "unknown", text: "Not sure" },
  { type: "option", id: "ai", text: "Written by an AI assist" },
  { type: "option", id: "manual", text: "I wrote it" },
] as const;

export interface FormState {
  draftText: string;
  origin: string;
  reasonCode: string | null;
  note: string;
  draftAt: number;
  runId?: string;
  model?: string | null;
}

/** The panel: draft status, where the draft came from, the reason picker, the Capture button. */
export function formCanvas(opts: {
  settings: AppSettings;
  form: FormState;
  message?: { text: string; style: "muted" | "error" };
}): CanvasResponse {
  const { settings, form } = opts;
  const draft: DraftState | null = form.draftText.trim()
    ? { text: form.draftText, origin: "unknown", at: form.draftAt }
    : null;
  const components: Component[] = [
    { type: "text", id: "status", text: statusLine(draft), style: "header" },
    {
      type: "textarea",
      id: "draft_text",
      label: "The AI draft",
      value: form.draftText,
      placeholder: "Paste the draft the AI wrote, before you edited it",
    },
    {
      type: "single-select",
      id: "draft_origin",
      label: "Where did the draft come from?",
      value: form.origin,
      options: ORIGIN_OPTIONS.map((o) => ({ ...o })),
    },
    {
      type: "single-select",
      id: "reason_code",
      label: "Why did you change it?",
      ...(form.reasonCode ? { value: form.reasonCode } : {}),
      options: quickReasons(settings).map((r) => ({ type: "option" as const, id: r.code, text: r.label })),
    },
    { type: "textarea", id: "reason_note", label: "Anything else? Optional.", value: form.note },
  ];
  if (opts.message) {
    components.push({ type: "text", id: "message", text: opts.message.text, style: opts.message.style });
  }
  components.push({
    type: "button",
    id: CAPTURE_BUTTON_ID,
    label: "Capture this reply",
    style: "primary",
    action: { type: "submit" },
  });
  return {
    canvas: {
      content: { components },
      stored_data: {
        draftAt: form.draftAt,
        ...(form.runId ? { runId: form.runId } : {}),
        ...(form.model ? { model: form.model } : {}),
      },
    },
  };
}

export function messageCanvas(text: string, style: "muted" | "error" = "muted"): CanvasResponse {
  return { canvas: { content: { components: [{ type: "text", id: "message", text, style }] } } };
}
