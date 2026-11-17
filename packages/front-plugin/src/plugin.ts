import type { CaptureResult } from "@overturn-ai/shared";
import type { ReasonCodeOption } from "@overturn-ai/shared/capture";
import {
  type AppSettings,
  composerChanged,
  createDraftDetector,
  type DraftDetector,
  type DraftState,
  decideOnFrontSend,
  decisionFieldsFrom,
  externalIdFor,
  type FrontComment,
  type FrontConversation,
  type FrontMessage,
  findSentMessage,
  inScope,
  quickReasons,
  snapshotFrom,
  statusLine,
  stripHtml,
} from "./capture";

/**
 * The slice of Front's plugin SDK (`@frontapp/plugin-sdk` 1.x) this plugin uses. main.ts adapts
 * the real `Front` object to it; tests pass a mock. There is no send event and no pre-send
 * veto in this API: a send is inferred from the draft closing and a new outbound message.
 */
export interface FrontContextLike {
  type: string;
  conversation?: FrontConversation | undefined;
  teammate?: { email?: string; name?: string } | undefined;
}
export interface Page<T> {
  results: readonly T[];
  nextPageToken?: string | undefined;
}
export interface RelayResponse {
  status: number;
  body: unknown;
}
export interface FrontSdk {
  fetchDraft(draftId: string): Promise<{ content: { body: string; type: string } } | undefined>;
  listMessages(pageToken?: string): Promise<Page<FrontMessage>>;
  listComments(pageToken?: string): Promise<Page<FrontComment>>;
  /** Through the Front app's Server, which attaches the Overturn API key (never seen by this page). */
  relayHttp(req: {
    verb: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
  }): Promise<RelayResponse>;
}

export interface PanelState {
  mode: "idle" | "out-of-scope" | "watching";
  status: string;
  /** Soft gate before the send, or the held capture after it. Empty when there is nothing to say. */
  hint: string;
  note: string;
  reasons: readonly ReasonCodeOption[];
  reasonCode: string | null;
  /** A changed reply was sent without a reason and is waiting for one (require_reason). */
  pending: boolean;
}

interface Held {
  conversation: FrontConversation;
  sentText: string;
  draft: DraftState;
  draftFields: Record<string, unknown>;
  messages: readonly FrontMessage[];
  comments: readonly FrontComment[];
  sentAt: number;
}

/** Everything the panel knows about one conversation; switching conversations never mixes them. */
interface ConversationState {
  conversation: FrontConversation;
  detector: DraftDetector;
  draftId: string | undefined;
  composer: string;
  knownIds: Set<string> | null;
  draftFields: Record<string, unknown>;
  reasonCode: string | null;
  reason: string;
  held: Held | null;
  lastResult: { kind: string; changed: boolean; dedup: boolean } | null;
  note: string;
  recordedChecked: boolean;
}

export interface PluginDeps {
  front: FrontSdk;
  settings: AppSettings;
  render(state: PanelState): void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, err?: unknown) => void;
  /** How long to look for the sent message after the draft closes (covers Front's "Undo send"). */
  sentWaitMs?: number;
  sentPollMs?: number;
}

const MAX_PAGES = 20;

async function all<T>(list: (token?: string) => Promise<Page<T>>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = await list(token);
    out.push(...page.results);
    token = page.nextPageToken;
    if (!token) break;
  }
  return out;
}

export function createPlugin(deps: PluginDeps) {
  const { front, settings } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((msg: string, err?: unknown) => console.warn(`[overturn] ${msg}`, err ?? ""));
  const sentWaitMs = deps.sentWaitMs ?? 60_000;
  const sentPollMs = deps.sentPollMs ?? 3_000;
  const reasons = quickReasons(settings);

  const states = new Map<string, ConversationState>();
  let current: ConversationState | null = null;
  let mode: PanelState["mode"] = "idle";
  let actor: string | null = null;
  let polling = false;

  const fresh = (conversation: FrontConversation): ConversationState => ({
    conversation,
    detector: createDraftDetector({ minDraftChars: settings.minDraftChars }),
    draftId: undefined,
    composer: "",
    knownIds: null,
    draftFields: {},
    reasonCode: null,
    reason: "",
    held: null,
    lastResult: null,
    note: "",
    recordedChecked: false,
  });

  const render = (): void => {
    const s = current;
    if (!s || mode !== "watching") {
      deps.render({
        mode,
        status:
          mode === "out-of-scope" ? `Not watching: no "${settings.scopeTag}" tag` : "Open a conversation",
        hint: "",
        note: "",
        reasons,
        reasonCode: null,
        pending: false,
      });
      return;
    }
    const draft = s.detector.current();
    let hint = "";
    if (s.held) hint = "Sent with changes · pick why to save this correction";
    else if (settings.requireReason && !s.reasonCode && composerChanged(draft, s.composer))
      hint = "Changed from the draft · pick why before you send";
    deps.render({
      mode,
      status: s.held ? "Sent · waiting for a reason" : statusLine(draft, s.lastResult),
      hint,
      note: s.note,
      reasons,
      reasonCode: s.reasonCode,
      pending: s.held !== null,
    });
  };

  /** A new draft cycle on the same conversation: the detector starts over, choices are kept only while unsent. */
  const resetDraft = (s: ConversationState): void => {
    s.detector = createDraftDetector({ minDraftChars: settings.minDraftChars });
    s.draftId = undefined;
    s.composer = "";
    s.knownIds = null;
    s.draftFields = {};
    s.recordedChecked = false;
  };

  const lookupRecorded = async (s: ConversationState): Promise<void> => {
    s.recordedChecked = true;
    try {
      const q = `externalId=${encodeURIComponent(externalIdFor(s.conversation.id))}&agent=${encodeURIComponent(settings.agent)}&limit=1`;
      const r = await front.relayHttp({ verb: "GET", url: `${settings.baseUrl}/v1/runs?${q}` });
      const items = (r.body as { items?: Array<{ id: string; output: unknown }> } | null)?.items;
      const run = r.status < 400 ? items?.[0] : undefined;
      if (run && typeof run.output === "string" && run.output.trim() && !s.detector.current()) {
        s.detector.set({ text: run.output, origin: "recorded", runId: run.id, at: now() });
      }
    } catch {
      // no recorded draft; the composer is watched instead
    }
  };

  /** Read once, when a draft first appears: which messages already exist, and the decision fields as drafted. */
  const onDraftAppeared = async (s: ConversationState): Promise<void> => {
    try {
      s.knownIds = new Set((await all((t) => front.listMessages(t))).map((m) => m.id));
    } catch (e) {
      log("could not list messages", e);
      s.knownIds = new Set();
    }
    s.draftFields = decisionFieldsFrom(s.conversation, settings);
  };

  const post = async (s: ConversationState, held: Held): Promise<void> => {
    const snapshot = snapshotFrom({
      conversation: held.conversation,
      messages: held.messages,
      comments: held.comments,
      settings,
    });
    const decision = decideOnFrontSend({
      conversation: held.conversation,
      snapshot,
      draft: held.draft,
      draftFields: held.draftFields,
      sentText: held.sentText,
      reasonCode: s.reasonCode,
      reason: s.reason,
      actor,
      settings,
      now: held.sentAt,
    });
    if (decision.action === "skip") {
      s.held = null;
      render();
      return;
    }
    if (decision.action === "need-reason") {
      // Front's Send cannot be held back from a plugin, so the correction is held instead.
      s.held = held;
      render();
      return;
    }
    s.held = null;
    try {
      const r = await front.relayHttp({
        verb: "POST",
        url: `${settings.baseUrl}/v1/capture`,
        headers: { "Content-Type": "application/json" },
        body: decision.body,
      });
      if (r.status >= 400) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
      const res = r.body as CaptureResult;
      s.lastResult = { kind: res.kind, changed: res.changed, dedup: res.deduplicated };
      s.note = res.changed && res.case ? `Case: ${res.case.title}` : "";
    } catch (e) {
      // Never in the way: the reply is already sent; say what happened and move on.
      log("capture failed", e);
      s.note = `Overturn could not save this correction (${(e as { status?: number }).status ?? "network"}).`;
    }
    s.reasonCode = null;
    s.reason = "";
    render();
  };

  /** The draft closed: find the message it became, or conclude it was discarded. */
  const onDraftClosed = async (s: ConversationState): Promise<void> => {
    const draft = s.detector.current();
    const knownIds = s.knownIds;
    const draftFields = s.draftFields;
    const composer = s.composer;
    resetDraft(s);
    if (!draft || !knownIds) {
      render();
      return;
    }
    const sentAt = now();
    let sent: FrontMessage | null = null;
    let messages: FrontMessage[] = [];
    for (let waited = 0; ; waited += sentPollMs) {
      try {
        messages = await all((t) => front.listMessages(t));
        sent = findSentMessage(knownIds, messages);
      } catch (e) {
        log("could not list messages", e);
      }
      if (sent || waited >= sentWaitMs) break;
      await sleep(sentPollMs);
    }
    if (!sent) {
      s.note = composer.trim() ? "Draft closed without sending · nothing captured" : "";
      render();
      return;
    }
    let comments: FrontComment[] = [];
    if (settings.captureInternalNotes) {
      try {
        comments = await all((t) => front.listComments(t));
      } catch (e) {
        log("could not list comments", e);
      }
    }
    const context = messages.filter((m) => m.id !== sent.id);
    await post(s, {
      conversation: s.conversation,
      sentText: sent.content?.body ?? composer,
      draft,
      draftFields,
      messages: context,
      comments,
      sentAt,
    });
  };

  return {
    /** Feed every `Front.contextUpdates` value. */
    async onContext(ctx: FrontContextLike): Promise<void> {
      actor = ctx.teammate?.email ?? actor;
      const conversation = ctx.type === "singleConversation" ? ctx.conversation : undefined;
      if (!conversation) {
        current = null;
        mode = "idle";
        render();
        return;
      }
      if (
        !inScope(
          (conversation.tags ?? []).map((t) => t.name),
          settings,
        )
      ) {
        current = null;
        mode = "out-of-scope";
        render();
        return;
      }
      const s = states.get(conversation.id) ?? fresh(conversation);
      states.set(conversation.id, s);
      s.conversation = conversation;
      current = s;
      mode = "watching";
      const before = s.draftId;
      if (before && conversation.draftId !== before) await onDraftClosed(s);
      if (conversation.draftId && !s.draftId) s.draftId = conversation.draftId;
      render();
    },

    /** Called on a timer: Front sends no context update while the teammate types. */
    async poll(): Promise<void> {
      const s = current;
      if (!s?.draftId || polling) return;
      polling = true;
      try {
        if (!s.recordedChecked) await lookupRecorded(s);
        let d: Awaited<ReturnType<FrontSdk["fetchDraft"]>>;
        try {
          d = await front.fetchDraft(s.draftId);
        } catch (e) {
          log("could not read the draft", e);
          return;
        }
        if (!d) {
          await onDraftClosed(s);
          return;
        }
        const text = d.content.type === "html" ? stripHtml(d.content.body) : d.content.body;
        s.composer = text;
        const had = s.detector.current();
        s.detector.onComposer(text, now());
        if (s.detector.current() && !s.knownIds) await onDraftAppeared(s);
        if (!had && s.detector.current()) {
          s.lastResult = null;
          s.note = "";
        }
        render();
      } finally {
        polling = false;
      }
    },

    /** "Use the current text as the draft". */
    async markCurrent(): Promise<void> {
      const s = current;
      if (!s?.draftId) return;
      const d = await front.fetchDraft(s.draftId);
      const text = d ? (d.content.type === "html" ? stripHtml(d.content.body) : d.content.body) : "";
      if (!text.trim()) return;
      s.detector.set({ text, origin: "manual", at: now() });
      s.composer = text;
      s.lastResult = null;
      if (!s.knownIds) await onDraftAppeared(s);
      render();
    },

    /** A reason chip: toggles; with a held correction, picking one sends it. */
    async pickReason(code: string): Promise<void> {
      const s = current;
      if (!s) return;
      s.reasonCode = s.reasonCode === code ? null : code;
      if (s.held && s.reasonCode) await post(s, s.held);
      else render();
    },

    setReasonNote(text: string): void {
      if (current) current.reason = text;
    },

    /** Drop a held correction without saving it. */
    discardHeld(): void {
      if (!current?.held) return;
      current.held = null;
      current.note = "Correction not saved";
      render();
    },

    /** For tests and debugging. */
    state(): ConversationState | null {
      return current;
    },
  };
}

export type Plugin = ReturnType<typeof createPlugin>;
