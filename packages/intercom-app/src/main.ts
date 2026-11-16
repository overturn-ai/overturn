import type { CaptureResult } from "@overturn-ai/shared";
import {
  buildCanvas,
  type CanvasResponse,
  type ConversationSnapshot,
  createDraftDetector,
  type DraftOrigin,
  type DraftState,
  decideOnSend,
  inScope,
  settingsFrom,
} from "./capture";

export interface IntercomCanvasRequest {
  component_id?: string;
  input_values?: Record<string, string>;
  context?: {
    conversation?: {
      id?: string;
      title?: string | null;
      url?: string | null;
      tags?: string[];
      custom_attributes?: Record<string, unknown>;
      contact?: { name?: string | null; email?: string | null };
      parts?: ConversationSnapshot["parts"];
    };
    composer_text?: string;
    draft_origin?: DraftOrigin;
    send_type?: "comment" | "note" | string;
    actor_email?: string | null;
  };
  settings?: Record<string, unknown>;
}

/** Handles Intercom Canvas Kit initialize/submit events without ever blocking the agent's send. */
export async function handleCanvasWebhook(
  req: IntercomCanvasRequest,
  opts: {
    apiKey: string;
    fetchImpl?: typeof fetch;
    detector?: ReturnType<typeof createDraftDetector>;
  },
): Promise<CanvasResponse> {
  const settings = settingsFrom(req.settings ?? {});
  const fetchFn = opts.fetchImpl ?? fetch;
  const detector = opts.detector ?? createDraftDetector({ minDraftChars: settings.minDraftChars });

  const convRaw = req.context?.conversation;
  const conversation: ConversationSnapshot = {
    id: convRaw?.id ?? "unknown",
    title: convRaw?.title ?? null,
    contactEmail: convRaw?.contact?.email ?? null,
    contactName: convRaw?.contact?.name ?? null,
    parts: convRaw?.parts ?? [],
    tags: convRaw?.tags ?? [],
    customAttributes: convRaw?.custom_attributes ?? {},
    url: convRaw?.url ?? null,
  };

  if (settings.scopeTag && !inScope(conversation.tags, settings)) {
    return {
      canvas: {
        content: {
          components: [{ type: "text", text: `Not watching: no "${settings.scopeTag}" tag`, style: "muted" }],
        },
      },
    };
  }

  const composerText = req.context?.composer_text ?? "";
  if (req.component_id === "mark_draft" && composerText.trim()) {
    detector.set({ text: composerText, origin: "manual", at: Date.now() });
    return buildCanvas({
      draft: detector.current(),
      settings,
      lastResult: null,
      errorMessage: null,
    });
  }

  detector.onComposer(composerText, Date.now(), req.context?.draft_origin);

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let errorMessage: string | null = null;

  if (req.component_id === "capture_send") {
    const decision = decideOnSend({
      conversation,
      draft: detector.current(),
      draftFields: {},
      send: {
        text: composerText,
        type: req.context?.send_type ?? "comment",
        fields: conversation.customAttributes,
      },
      reasonCode: req.input_values?.reason_code ?? null,
      reason: req.input_values?.reason_note ?? "",
      actor: req.context?.actor_email ?? null,
      settings,
    });

    if (decision.action === "need-reason") {
      return buildCanvas({
        draft: detector.current(),
        settings,
        lastResult: null,
        errorMessage: "Pick a reason above before capturing this edit.",
        selectedReasonCode: req.input_values?.reason_code ?? null,
        reasonNote: req.input_values?.reason_note ?? "",
      });
    }

    if (decision.action === "capture") {
      try {
        const res = await fetchFn(`${settings.baseUrl}/v1/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify(decision.body),
        });
        if (!res.ok) {
          errorMessage = `Overturn unavailable (${res.status}) — send was not blocked.`;
        } else {
          const data = (await res.json()) as CaptureResult;
          lastResult = {
            kind: data.kind,
            changed: data.changed,
            dedup: Boolean(data.deduplicated),
          };
          detector.set(null as DraftState | null);
        }
      } catch {
        errorMessage = "Overturn unreachable — send was not blocked.";
      }
    }
  }

  return buildCanvas({
    draft: detector.current(),
    settings,
    lastResult,
    errorMessage,
    selectedReasonCode: req.input_values?.reason_code ?? null,
    reasonNote: req.input_values?.reason_note ?? "",
  });
}
