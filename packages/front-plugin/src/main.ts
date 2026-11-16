import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  type FrontSdkComment,
  type FrontSdkConversation,
  type FrontSdkMessage,
  inScope,
  quickReasons,
  settingsFrom,
  snapshotFromFront,
  statusLine,
} from "./capture";

/** The slice of the Front Plugin SDK context this plugin uses. */
export interface FrontContext {
  type: string;
  conversation?: FrontSdkConversation;
  draft?: {
    id: string;
    content?: { body: string; type?: "html" | "text" };
    subject?: string;
  };
  teammate?: {
    id: string;
    email?: string;
    name?: string;
  };
  preferences?: Record<string, unknown>;
  fetchDraft?: (
    draftId: string,
  ) => Promise<{ id: string; content?: { body: string; type?: "html" | "text" } } | undefined>;
  listMessages?: () => Promise<{ results: FrontSdkMessage[] }>;
  listComments?: () => Promise<{ results: FrontSdkComment[] }>;
  [key: string]: unknown;
}

export interface FrontBridge {
  contextUpdates: {
    subscribe: (callback: (context: FrontContext) => void) => { unsubscribe?: () => void };
  };
  fetchDraft?: (
    draftId: string,
  ) => Promise<{ id: string; content?: { body: string; type?: "html" | "text" } } | undefined>;
  listMessages?: () => Promise<{ results: FrontSdkMessage[] }>;
  listComments?: () => Promise<{ results: FrontSdkComment[] }>;
  [key: string]: unknown;
}

declare global {
  interface Window {
    Front?: FrontBridge;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

export function parseQueryParams(): Record<string, string> {
  const params: Record<string, string> = {};
  if (typeof location !== "undefined" && location.search) {
    const sp = new URLSearchParams(location.search);
    for (const [k, v] of sp.entries()) {
      params[k] = v;
    }
  }
  return params;
}

export interface PluginInstance {
  settings: AppSettings;
  detector: ReturnType<typeof createDraftDetector>;
  handleSend: (sentText: string, sendType?: string, sendFields?: Record<string, unknown>) => Promise<boolean>;
  destroy: () => void;
}

export async function initFrontPlugin(
  client?: FrontBridge,
  rootElement?: HTMLElement | null,
): Promise<PluginInstance | null> {
  const frontClient = client ?? (typeof window !== "undefined" ? window.Front : undefined);
  const root = rootElement ?? (typeof document !== "undefined" ? document.getElementById("app") : null);

  if (!root) return null;

  root.replaceChildren();

  const queryParams = parseQueryParams();
  let settings: AppSettings = settingsFrom(queryParams);
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const status = el("div", { class: "status" }, "Waiting for a draft");
  let reasonCode: string | null = null;
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];

  const updateChips = (): void => {
    quick.replaceChildren();
    chips.length = 0;
    for (const q of quickReasons(settings)) {
      const b = el(
        "button",
        { type: "button", class: "chip", "data-code": q.code },
        q.label,
      ) as HTMLButtonElement;
      b.addEventListener("click", () => {
        reasonCode = reasonCode === q.code ? null : q.code;
        for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
      });
      chips.push(b);
      quick.appendChild(b);
    }
  };
  updateChips();

  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;

  const actions = el("div", { class: "actions" });
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const captureBtn = el("button", { type: "button", class: "btn-capture" }, "Capture correction");
  actions.append(mark, captureBtn);

  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, actions, note);

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  let currentContext: FrontContext | null = null;
  let currentConversation: FrontSdkConversation | null = null;
  let draftFields: Record<string, unknown> = {};

  const readFields = (): Record<string, unknown> => {
    if (!currentConversation || settings.decisionFields.length === 0) return {};
    const attrs = currentConversation.customFieldAttributes ?? [];
    const fields: Record<string, unknown> = {};
    for (const df of settings.decisionFields) {
      const match = attrs.find((a) => a.id === df.id || a.name === df.label || a.name === df.id);
      fields[df.label] = match ? match.value : null;
    }
    return fields;
  };

  const handleSend = async (
    sentText: string,
    sendType = "publicReply",
    sendFields: Record<string, unknown> = {},
  ): Promise<boolean> => {
    const draft: DraftState | null = detector.current();
    if (!draft) return true;

    let messages: FrontSdkMessage[] = [];
    let comments: FrontSdkComment[] = [];
    try {
      if (currentContext?.listMessages) {
        const msgsRes = await currentContext.listMessages();
        messages = msgsRes.results ?? [];
      } else if (frontClient?.listMessages) {
        const msgsRes = (await frontClient.listMessages()) as { results: FrontSdkMessage[] };
        messages = msgsRes.results ?? [];
      }
    } catch {
      // ignore
    }

    try {
      if (currentContext?.listComments) {
        const comsRes = await currentContext.listComments();
        comments = comsRes.results ?? [];
      }
    } catch {
      // ignore
    }

    const conversationSnapshot: ConversationSnapshot = currentConversation
      ? snapshotFromFront(currentConversation, messages, comments, settings)
      : {
          id: "unknown",
          subject: null,
          recipientEmail: null,
          recipientName: null,
          messages: [],
          fields: {},
          url: null,
        };

    const mergedSendFields = { ...readFields(), ...sendFields };
    const decision = decideOnSend({
      conversation: conversationSnapshot,
      draft,
      draftFields,
      send: {
        text: sentText,
        type: sendType,
        fields: mergedSendFields,
      },
      reasonCode,
      reason: reason.value,
      actor: currentContext?.teammate?.email ?? null,
      settings,
      now: Date.now(),
    });

    if (decision.action === "skip") return true;

    if (decision.action === "need-reason") {
      chips[0]?.focus();
      note.textContent = `Overturn: pick why you changed the ${
        decision.changedFields.length ? decision.changedFields.join(", ") : "reply"
      } in the Overturn panel (one click).`;
      return false;
    }

    try {
      const res = await fetch(`${settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}),
        },
        body: JSON.stringify(decision.body),
      });

      if (res.ok) {
        const r = (await res.json()) as CaptureResult;
        lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
        note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
        reason.value = "";
        reasonCode = null;
        for (const c of chips) c.classList.remove("on");
        detector.set(null);
        render();
      } else {
        console.error("Overturn capture HTTP error:", res.status);
        note.textContent = `Overturn could not save this correction (${res.status}).`;
      }
    } catch (e) {
      // Never block the teammate's send on our failure; log and show notice.
      console.error("Overturn capture network error:", e);
      note.textContent = "Overturn could not save this correction (network error).";
    }

    return true;
  };

  mark.addEventListener("click", async () => {
    let text = "";
    if (currentContext?.type === "messageComposer" && currentContext.draft?.content?.body) {
      text = currentContext.draft.content.body;
    } else if (currentConversation?.draftId) {
      try {
        const fetchFn = currentContext?.fetchDraft ?? frontClient?.fetchDraft;
        const d = await fetchFn?.(currentConversation.draftId);
        text = d?.content?.body ?? "";
      } catch {
        // ignore
      }
    }
    if (!text.trim()) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });

  captureBtn.addEventListener("click", async () => {
    let currentComposerText = "";
    if (currentContext?.type === "messageComposer" && currentContext.draft?.content?.body) {
      currentComposerText = currentContext.draft.content.body;
    } else if (currentConversation?.draftId) {
      try {
        const fetchFn = currentContext?.fetchDraft ?? frontClient?.fetchDraft;
        const d = await fetchFn?.(currentConversation.draftId);
        currentComposerText = d?.content?.body ?? "";
      } catch {
        // ignore
      }
    }
    await handleSend(currentComposerText);
  });

  let subscription: { unsubscribe?: () => void } | undefined;
  if (frontClient?.contextUpdates?.subscribe) {
    subscription = frontClient.contextUpdates.subscribe(async (context: FrontContext) => {
      currentContext = context;

      if (context.preferences) {
        settings = settingsFrom({ ...queryParams, ...context.preferences });
        updateChips();
      }

      if (context.type !== "singleConversation" && context.type !== "messageComposer") {
        status.textContent = "Waiting for a conversation";
        return;
      }

      const conv = context.conversation;
      if (conv) {
        currentConversation = conv;
        draftFields = readFields();

        // Scope tag filter
        if (settings.scopeTag) {
          const tags = conv.tags?.map((t) => t.name ?? "").filter(Boolean) ?? [];
          if (!inScope(tags, settings)) {
            status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
            quick.remove();
            reason.remove();
            actions.remove();
            return;
          }
        }

        // Look for recorded run from SDK
        try {
          const res = await fetch(
            `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`fr:${conv.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
            {
              headers: settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {},
            },
          );
          if (res.ok) {
            const found = (await res.json()) as { items?: Array<{ id: string; output: unknown }> };
            const run = found.items?.[0];
            if (run && typeof run.output === "string" && run.output.trim()) {
              detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
            }
          }
        } catch {
          // no recorded draft
        }
      }

      // Check for draft in messageComposer or singleConversation
      let draftBody = "";
      if (context.type === "messageComposer" && context.draft?.content?.body) {
        draftBody = context.draft.content.body;
      } else if (conv?.draftId) {
        try {
          const fetchFn = context.fetchDraft ?? frontClient.fetchDraft;
          const d = await fetchFn?.(conv.draftId);
          draftBody = d?.content?.body ?? "";
        } catch {
          // ignore
        }
      }

      if (draftBody) {
        if (detector.onComposer(draftBody)) {
          render();
        }
      } else {
        render();
      }
    });
  }

  render();

  return {
    settings,
    detector,
    handleSend,
    destroy: () => {
      subscription?.unsubscribe?.();
    },
  };
}

if (typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void initFrontPlugin());
  } else {
    void initFrontPlugin();
  }
}
