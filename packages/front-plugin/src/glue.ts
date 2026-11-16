import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  statusLine,
} from "./capture";

/**
 * The conversation as the controller sees it. `main.ts` builds one from each Front context update.
 * Nothing but the composer text is read until a draft exists: `listMessages` and `listComments`
 * are only called after one appears.
 */
export interface ConversationView {
  id: string;
  subject: string | null;
  recipient: string | null;
  url: string | null;
  actor: string | null;
  /** The reply box content, or null when the composer is closed or unreadable. */
  draftText: string | null;
  listMessages(): Promise<ConversationSnapshot["messages"]>;
  listComments(): Promise<ConversationSnapshot["comments"]>;
}

export interface Controller {
  /** Feed every context update for the open conversation. */
  onConversation(view: ConversationView): Promise<void>;
  /** The agent marks the current composer text as the draft. */
  markDraft(view: ConversationView): Promise<void>;
  /** The agent picks a reason and/or writes a note; releases a held capture when it now qualifies. */
  setReason(code: string | null, note: string): Promise<void>;
  /** Status line and any note for the panel. */
  state(): { status: string; note: string; needsReason: boolean };
}

export interface ControllerDeps {
  settings: AppSettings;
  apiKey: string;
  fetch: typeof fetch;
  now?: () => number;
  onChange?: () => void;
}

export function createController(deps: ControllerDeps): Controller {
  const { settings } = deps;
  const now = deps.now ?? Date.now;
  let conversationId: string | null = null;
  let detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
  let baseline: Set<string> | null = null;
  let held: { view: ConversationView; sentText: string } | null = null;
  let reasonCode: string | null = null;
  let reason = "";
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let note = "";
  let needsReason = false;
  let busy = false;

  const reset = (): void => {
    detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
    baseline = null;
    held = null;
    reasonCode = null;
    reason = "";
    needsReason = false;
  };
  const changed = (): void => deps.onChange?.();

  async function finish(view: ConversationView, sentText: string): Promise<void> {
    const draft: DraftState | null = detector.current();
    const [messages, comments] = await Promise.all([view.listMessages(), view.listComments()]);
    const decision = decideOnSend({
      conversation: {
        id: view.id,
        subject: view.subject,
        recipient: view.recipient,
        messages,
        comments,
        url: view.url,
      },
      draft,
      send: { text: sentText },
      reasonCode,
      reason,
      actor: view.actor,
      settings,
      now: now(),
    });
    if (decision.action === "skip") {
      reset();
      return;
    }
    if (decision.action === "need-reason") {
      // Front gives plugins no pre-send hook, so the capture is held until a reason is picked.
      held = { view, sentText };
      needsReason = true;
      note = `Pick why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"} to save it.`;
      lastResult = null;
      changed();
      return;
    }
    held = null;
    needsReason = false;
    try {
      const res = await deps.fetch(`${settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${deps.apiKey}` },
        body: JSON.stringify(decision.body),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const r = (await res.json()) as CaptureResult;
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      note = r.changed && r.case ? `Case: ${r.case.title}` : "";
    } catch (e) {
      // Never block the agent's work on our failure; log it and say so in the panel.
      console.warn("Overturn capture failed", e instanceof Error ? e.message : e);
      lastResult = null;
      note = "Overturn could not save this correction.";
    }
    reset();
    changed();
  }

  return {
    async onConversation(view) {
      if (view.id !== conversationId) {
        conversationId = view.id;
        reset();
        lastResult = null;
        note = "";
      }
      if (busy || held) return;
      busy = true;
      try {
        const before = detector.current();
        const found = view.draftText !== null ? detector.onComposer(view.draftText, now()) : null;
        if (found && !before) {
          lastResult = null;
          note = "";
          // Remember what was already in the thread, to recognise the reply that follows.
          baseline = new Set((await view.listMessages()).map((m) => m.id));
          changed();
          return;
        }
        if (!detector.current() || !baseline) return;
        const sent = (await view.listMessages()).find((m) => !baseline?.has(m.id) && !m.isInbound);
        if (sent) await finish(view, sent.body);
      } catch (e) {
        console.warn("Overturn could not read the conversation", e instanceof Error ? e.message : e);
      } finally {
        busy = false;
      }
    },
    async markDraft(view) {
      if (!view.draftText?.trim()) return;
      detector.set({ text: view.draftText, origin: "manual", at: now() });
      baseline = new Set((await view.listMessages()).map((m) => m.id));
      lastResult = null;
      changed();
    },
    async setReason(code, text) {
      reasonCode = code;
      reason = text;
      if (held) {
        const { view, sentText } = held;
        held = null;
        busy = true;
        try {
          await finish(view, sentText);
        } finally {
          busy = false;
        }
      }
    },
    state: () => ({ status: statusLine(detector.current(), lastResult), note, needsReason }),
  };
}
