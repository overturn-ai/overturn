import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  buildCapturePayload,
  createDraftDetector,
  type DraftDetector,
  type FrontComment,
  type FrontConversation,
  type FrontMessage,
  type FrontSettings,
  plainText,
  statusLine,
} from "./capture";

/** A draft as returned by the SDK's fetchDraft (undefined when it is gone). */
export interface FrontDraft {
  id: string;
  content: { body: string; type: "html" | "text" };
}

/**
 * The singleConversation context, shaped after the official Plugin SDK types
 * (@frontapp/plugin-sdk 1.8.1): listMessages and listComments are context
 * methods, a message carries `status` ("inbound" | "outbound") — there is no
 * is_inbound flag — and message content may be undefined until it has loaded.
 */
export interface FrontContext {
  type: string;
  teammate?: { email?: string };
  conversation?: FrontConversation;
  listMessages(paginationToken?: string): Promise<{ results: FrontMessage[]; nextPageToken?: string }>;
  listComments(paginationToken?: string): Promise<{ results: FrontComment[]; nextPageToken?: string }>;
}

export interface FrontSdk {
  fetchDraft(id: string): Promise<FrontDraft | undefined>;
}

/** The sidebar panel, abstracted so the controller can be tested without a DOM. */
export interface ControllerView {
  render(status: string, hint: string): void;
  showFeedback(text: string): void;
  readNote(): string;
  writeNote(text: string): void;
  selectReason(code: string | null): void;
}

export type PostCapture = (url: string, body: CaptureCreate) => Promise<CaptureResult>;

/**
 * Everything the plugin is tracking for one conversation. State is kept per
 * conversation id and never shared: switching conversations parks the current
 * state (draft, held capture, picked reason, note) and restores the target
 * conversation's own, so a reason picked in A can never leak into B, and A's
 * held capture is still there when the teammate comes back to it.
 */
interface ConversationState {
  id: string;
  context: FrontContext;
  conversation: FrontConversation;
  actor: string | null;
  detector: DraftDetector;
  draftId: string | null;
  snapshotMessages: FrontMessage[];
  snapshotComments: FrontComment[];
  earlierIds: Set<string>;
  pending: FrontMessage | null;
  reasonCode: string | null;
  note: string;
  goneAt: number;
  capturedIds: Set<string>;
  sending: boolean;
}

export interface CaptureController {
  onContext(next: FrontContext): void;
  toggleReason(code: string): Promise<void>;
  markDraft(): Promise<void>;
  poll(): Promise<void>;
  /** Test/inspection hook: the active conversation's tracked state. */
  inspect(): {
    conversationId: string | null;
    draftId: string | null;
    pendingId: string | null;
    reasonCode: string | null;
  };
}

async function readAll<T>(
  list: (token?: string) => Promise<{ results: T[]; nextPageToken?: string }>,
): Promise<T[]> {
  const all: T[] = [];
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await list(token);
    all.push(...result.results);
    if (!result.nextPageToken || result.nextPageToken === token) break;
    token = result.nextPageToken;
  }
  return all;
}

function messageText(message: FrontMessage): string {
  return message.content ? plainText(message.content.body, message.content.type) : "";
}

function timeMs(value: Date | string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function createCaptureController(deps: {
  sdk: FrontSdk;
  settings: FrontSettings;
  view: ControllerView;
  postCapture: PostCapture;
  now?: () => number;
  logError?: (message: string, error: unknown) => void;
}): CaptureController {
  const { sdk, settings, view, postCapture } = deps;
  const now = deps.now ?? Date.now;
  const logError =
    deps.logError ??
    ((message: string, error: unknown) => {
      console.error(message, error);
    });
  const states = new Map<string, ConversationState>();
  let active: ConversationState | null = null;
  let polling = false;

  const freshState = (context: FrontContext, conversation: FrontConversation): ConversationState => ({
    id: conversation.id,
    context,
    conversation,
    actor: context.teammate?.email ?? null,
    detector: createDraftDetector(settings.minDraftChars),
    draftId: null,
    snapshotMessages: [],
    snapshotComments: [],
    earlierIds: new Set(),
    pending: null,
    reasonCode: null,
    note: "",
    goneAt: 0,
    capturedIds: new Set(),
    sending: false,
  });

  const render = (state: ConversationState): void => {
    if (state !== active) return;
    view.render(
      statusLine(state.detector.current()),
      state.pending
        ? "Sent reply found. Pick a reason to save the correction."
        : state.detector.current()
          ? "Choose a reason before sending if you change the draft."
          : "Waiting for a reply-sized draft.",
    );
  };

  /** Drop everything tracked for one draft cycle (sent, deleted, or given up on). */
  const clearTracking = (state: ConversationState): void => {
    state.detector = createDraftDetector(settings.minDraftChars);
    state.draftId = null;
    state.snapshotMessages = [];
    state.snapshotComments = [];
    state.earlierIds = new Set();
    state.pending = null;
    state.goneAt = 0;
    state.reasonCode = null;
    state.note = "";
    if (state === active) {
      view.writeNote("");
      view.selectReason(null);
    }
  };

  /** Baseline for a draft: the thread as it stood when the draft appeared. */
  const snapshot = async (state: ConversationState): Promise<void> => {
    const context = state.context;
    const [messages, comments] = await Promise.all([
      readAll((token) => context.listMessages(token)),
      // listComments is part of the SDK's singleConversation context; the
      // typeof guard keeps a host without it from breaking message capture.
      typeof context.listComments === "function"
        ? readAll((token) => context.listComments(token))
        : Promise.resolve<FrontComment[]>([]),
    ]);
    state.snapshotMessages = messages.slice(-500);
    state.snapshotComments = comments;
    state.earlierIds = new Set(messages.map((message) => message.id));
  };

  const attemptSubmit = async (state: ConversationState): Promise<void> => {
    const pending = state.pending;
    if (!pending || state.sending) return;
    const decision = buildCapturePayload({
      conversation: state.conversation,
      // The baseline predates the send; the filter is belt and braces so the
      // sent reply itself never lands in its own context.
      context: state.snapshotMessages.filter((message) => message.id !== pending.id),
      comments: state.snapshotComments,
      draft: state.detector.current(),
      sent: pending,
      actor: state.actor,
      reasonCode: state.reasonCode,
      reason: state === active ? view.readNote() : state.note,
      settings,
      now: now(),
    });
    if (decision.action === "need-reason") {
      render(state);
      return;
    }
    if (decision.action !== "capture") {
      // "empty": the sent message's content has not loaded yet. Stay pending;
      // a later poll refreshes the body and retries. Never wedge on it.
      return;
    }
    state.sending = true;
    state.capturedIds.add(pending.id);
    try {
      const result = await postCapture(settings.captureUrl, decision.body);
      if (state === active) {
        view.showFeedback(
          result.changed
            ? result.deduplicated
              ? "Captured · already in the suite"
              : "Captured · edit saved as a case"
            : "Sent as drafted · approved",
        );
      }
    } catch (error) {
      // Capture failure is logged and shown, and that is all: the Front send
      // already happened and is never blocked or retried in a loop.
      logError("Overturn capture failed", error);
      if (state === active) {
        view.showFeedback("Overturn could not save this reply. Your Front send was unaffected.");
      }
    } finally {
      state.sending = false;
      clearTracking(state);
      render(state);
    }
  };

  /** A held capture whose body had not loaded gets first claim on the round. */
  const refreshPending = async (state: ConversationState): Promise<void> => {
    const pending = state.pending;
    if (!pending) return;
    if (messageText(pending)) {
      await attemptSubmit(state);
      return;
    }
    let messages: FrontMessage[];
    try {
      messages = await readAll((token) => state.context.listMessages(token));
    } catch (error) {
      logError("Overturn could not refresh the sent reply", error);
      return;
    }
    if (state !== active) return;
    const fresh = messages.find((message) => message.id === pending.id);
    if (fresh && messageText(fresh)) {
      state.pending = fresh;
      await attemptSubmit(state);
    }
    // Still no body: stay pending and let the next round look again.
  };

  /**
   * Which new outbound message is the reply that consumed the draft? The
   * earliest one not in the baseline, preferring the current teammate's own
   * sends when several teammates replied, and preferring a loaded body.
   */
  const pickSent = (state: ConversationState, messages: FrontMessage[]): FrontMessage | null => {
    const candidates = messages
      .filter(
        (message) =>
          !state.earlierIds.has(message.id) &&
          !state.capturedIds.has(message.id) &&
          message.status === "outbound",
      )
      .sort((a, b) => timeMs(a.date) - timeMs(b.date));
    if (candidates.length === 0) return null;
    const actor = state.actor?.toLowerCase();
    const own = actor ? candidates.filter((message) => message.from?.handle?.toLowerCase() === actor) : [];
    const pool = own.length > 0 ? own : candidates;
    return pool.find((message) => messageText(message)) ?? pool[0] ?? null;
  };

  const pollOnce = async (state: ConversationState): Promise<void> => {
    if (state.pending) {
      await refreshPending(state);
      return;
    }
    const draftId = state.conversation.draftId ?? null;
    if (draftId && (!state.draftId || draftId === state.draftId)) {
      let draft: FrontDraft | undefined;
      try {
        draft = await sdk.fetchDraft(draftId);
      } catch (error) {
        logError("Overturn could not read the draft", error);
        return;
      }
      if (state !== active) return;
      if (draft) {
        const text = plainText(draft.content.body, draft.content.type);
        const found = state.detector.onComposer(draft.id, text, now());
        if (found) {
          state.draftId = draft.id;
          await snapshot(state);
          state.goneAt = 0;
          render(state);
        } else if (state.detector.current()) {
          state.goneAt = 0;
        }
        // A draft is in the composer (or not reply-sized yet): nothing sent.
        return;
      }
      // fetchDraft found nothing: the draft vanished between the context
      // update and the fetch. Fall through and look for the send it became.
    } else if (!draftId) {
      // Observe the empty composer too, so a draft that arrives later is a
      // jump ("inserted"), not a first sighting ("preloaded").
      state.detector.onComposer("", "", now());
    }
    if (!state.detector.current() || !state.draftId) return;
    if (!state.goneAt) state.goneAt = now();
    let messages: FrontMessage[];
    try {
      messages = await readAll((token) => state.context.listMessages(token));
    } catch (error) {
      logError("Overturn could not confirm the sent reply", error);
      return;
    }
    if (state !== active) return;
    const sent = pickSent(state, messages);
    if (!sent) {
      // Draft deleted (or sent somewhere we cannot see): stop tracking it.
      if (now() - state.goneAt > 30_000) {
        clearTracking(state);
        render(state);
      }
      return;
    }
    state.pending = sent;
    render(state);
    await attemptSubmit(state);
  };

  return {
    onContext(next: FrontContext): void {
      const selected = next.type === "singleConversation" ? next.conversation : null;
      if (active) active.note = view.readNote();
      if (!selected) {
        active = null;
        view.render("Select one conversation", "A draft must appear before the conversation is read.");
        return;
      }
      let state = states.get(selected.id);
      if (!state) {
        state = freshState(next, selected);
        states.set(selected.id, state);
      }
      state.context = next;
      state.conversation = selected;
      state.actor = next.teammate?.email ?? null;
      const switched = state !== active;
      active = state;
      if (switched) {
        view.writeNote(state.note);
        view.selectReason(state.reasonCode);
        view.showFeedback("");
      }
      render(state);
    },

    async toggleReason(code: string): Promise<void> {
      if (!active) return;
      active.reasonCode = active.reasonCode === code ? null : code;
      view.selectReason(active.reasonCode);
      await attemptSubmit(active);
    },

    async markDraft(): Promise<void> {
      const state = active;
      if (!state?.conversation.draftId) return;
      const draftId = state.conversation.draftId;
      try {
        const draft = await sdk.fetchDraft(draftId);
        if (!draft) return;
        const text = plainText(draft.content.body, draft.content.type);
        if (!text) return;
        state.detector.set({ id: draft.id, text, origin: "manual", at: now() });
        state.draftId = draft.id;
        await snapshot(state);
        state.goneAt = 0;
        render(state);
      } catch (error) {
        logError("Overturn could not read the draft", error);
      }
    },

    async poll(): Promise<void> {
      const state = active;
      if (!state || state.sending || polling) return;
      polling = true;
      try {
        await pollOnce(state);
      } catch (error) {
        logError("Overturn could not poll Front", error);
      } finally {
        polling = false;
      }
    },

    inspect() {
      return {
        conversationId: active?.id ?? null,
        draftId: active?.draftId ?? null,
        pendingId: active?.pending?.id ?? null,
        reasonCode: active?.reasonCode ?? null,
      };
    },
  };
}
