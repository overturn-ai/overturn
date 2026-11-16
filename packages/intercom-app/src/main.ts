import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  buildCanvas,
  type CanvasResponse,
  type ConversationSnapshot,
  conversationSnapshotFrom,
  DEFAULT_SETTINGS,
  type DraftState,
  decideOnSend,
  executeCapture,
} from "./capture.js";

export * from "./capture.js";

export interface IntercomCanvasPayload {
  workspace_id?: string;
  admin?: {
    id?: string;
    email?: string;
    name?: string;
  };
  conversation?: Record<string, unknown>;
  component_id?: string;
  input_values?: Record<string, unknown>;
  current_canvas?: CanvasResponse["canvas"];
  stored_data?: Record<string, unknown>;
}

export interface IntercomWebhookPayload {
  type?: string;
  topic?: string;
  app_id?: string;
  data?: {
    item?: Record<string, unknown>;
  };
}

export interface IntercomAppConfig {
  apiKey?: string;
  settings?: Partial<AppSettings>;
  fetchFn?: typeof fetch;
}

/**
 * Handles Canvas Kit Initialize and Submit requests from Intercom.
 */
export async function handleCanvasRequest(
  payload: IntercomCanvasPayload,
  config?: IntercomAppConfig,
): Promise<CanvasResponse> {
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...(config?.settings ?? {}),
  };

  const stored = (payload.stored_data ?? payload.current_canvas?.stored_data ?? {}) as {
    draft?: DraftState | null;
    reasonCode?: string | null;
    reasonNote?: string;
    lastResult?: { kind: string; changed: boolean; dedup: boolean; caseTitle?: string | null } | null;
  };

  let draft: DraftState | null = stored.draft ?? null;
  let selectedReasonCode: string | null = stored.reasonCode ?? null;
  let reasonNote: string = stored.reasonNote ?? "";
  const lastResult = stored.lastResult ?? null;

  const rawConversation = payload.conversation ?? {};
  const conversation: ConversationSnapshot = conversationSnapshotFrom(rawConversation, settings);

  const componentId = payload.component_id;
  const inputValues = payload.input_values ?? {};

  if (typeof inputValues.reason_code === "string") {
    selectedReasonCode = inputValues.reason_code;
  }
  if (typeof inputValues.reason_note === "string") {
    reasonNote = inputValues.reason_note;
  }

  // Handle button clicks
  if (componentId === "mark_draft") {
    // Teammate chose to mark the current composer or last message text as draft
    const text =
      (typeof inputValues.composer_text === "string" && inputValues.composer_text.trim()) ||
      (typeof inputValues.text === "string" && inputValues.text.trim()) ||
      conversation.parts?.[conversation.parts.length - 1]?.body ||
      "";
    if (text) {
      draft = {
        text,
        origin: "manual",
        at: Date.now(),
      };
    }
  }

  // If a recorded draft exists from SDK run and no draft is currently held
  if (!draft && config?.apiKey && conversation.id) {
    try {
      const f = config.fetchFn ?? fetch;
      const res = await f(
        `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`ic:${conversation.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
        {
          headers: { Authorization: `Bearer ${config.apiKey}` },
        },
      );
      if (res.ok) {
        const found = (await res.json()) as {
          items?: Array<{ id: string; output: unknown; model?: string }>;
        };
        const run = found.items?.[0];
        if (run && typeof run.output === "string" && run.output.trim()) {
          draft = {
            text: run.output,
            origin: "ai",
            runId: run.id,
            model: run.model ?? null,
            at: Date.now(),
          };
        }
      }
    } catch {
      // Ignore failures finding recorded runs
    }
  }

  return buildCanvas({
    draft,
    selectedReasonCode,
    reasonNote,
    settings,
    lastResult,
  });
}

/**
 * Handles Intercom webhook events (e.g. conversation.admin.replied).
 */
export async function handleWebhookEvent(
  event: IntercomWebhookPayload,
  config: IntercomAppConfig & { apiKey: string },
): Promise<{ captured: boolean; result: CaptureResult | null }> {
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...(config.settings ?? {}),
  };

  const item = event.data?.item;
  if (!item) return { captured: false, result: null };

  const conversation = conversationSnapshotFrom(item, settings);
  const parts = conversation.parts ?? [];
  const latestPart = parts[parts.length - 1];

  if (!latestPart?.body) {
    return { captured: false, result: null };
  }

  // When a webhook fires without stored state, check if a draft was recorded for this conversation
  let draft: DraftState | null = null;
  if (config.apiKey && conversation.id) {
    try {
      const f = config.fetchFn ?? fetch;
      const res = await f(
        `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`ic:${conversation.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
        {
          headers: { Authorization: `Bearer ${config.apiKey}` },
        },
      );
      if (res.ok) {
        const found = (await res.json()) as {
          items?: Array<{ id: string; output: unknown; model?: string }>;
        };
        const run = found.items?.[0];
        if (run && typeof run.output === "string" && run.output.trim()) {
          draft = {
            text: run.output,
            origin: "ai",
            runId: run.id,
            model: run.model ?? null,
            at: Date.now(),
          };
        }
      }
    } catch {
      // Ignore
    }
  }

  if (!draft) {
    return { captured: false, result: null };
  }

  const decision = decideOnSend({
    conversation,
    draft,
    send: {
      text: latestPart.body,
      type: latestPart.partType === "note" ? "internalNote" : "publicReply",
      fields: conversation.fields,
    },
    reasonCode: null,
    actor: latestPart.authorEmail ?? latestPart.authorName ?? null,
    settings,
  });

  if (decision.action === "capture") {
    const result = await executeCapture({
      decision,
      settings,
      apiKey: config.apiKey,
      fetchFn: config.fetchFn,
    });
    return { captured: true, result };
  }

  return { captured: false, result: null };
}

/**
 * Web Standard Request handler for Canvas Kit initialize / submit / webhook routes.
 */
export async function handleRequest(request: Request, config?: IntercomAppConfig): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const json = (await request.json()) as Record<string, unknown>;

    // Webhook route
    if (pathname.endsWith("/webhook") || json.topic || json.type === "notification_event") {
      if (!config?.apiKey) {
        return new Response(JSON.stringify({ error: "Missing API key" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const outcome = await handleWebhookEvent(json as IntercomWebhookPayload, {
        ...config,
        apiKey: config.apiKey,
      });
      return new Response(JSON.stringify(outcome), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Canvas Kit route (initialize or submit)
    const canvasResponse = await handleCanvasRequest(json as IntercomCanvasPayload, config);
    return new Response(JSON.stringify(canvasResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (_err) {
    return new Response(
      JSON.stringify({
        canvas: {
          content: {
            components: [
              {
                type: "text",
                text: "Overturn: Error processing request",
                style: "header",
              },
            ],
          },
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
