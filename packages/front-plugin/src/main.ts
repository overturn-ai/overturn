import { contextUpdates } from "@frontapp/plugin-sdk";
import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

/**
 * The slice of the Front plugin SDK (ui-bridge v2) this plugin uses, typed structurally
 * the way the Zendesk app types ZAF. Contexts arrive on `contextUpdates`; a plugin placed
 * in the composer sees `messageComposer` contexts carrying the live draft, and one placed
 * in the sidebar sees `singleConversation` contexts for the open conversation.
 */
interface FrontRecipient {
  handle: string;
  name?: string;
}
interface FrontMessage {
  id: string;
  date?: unknown;
  content?: { body: string; type: "html" | "text" } | undefined;
  from: FrontRecipient;
}
interface FrontComment {
  id: string;
  postedAt?: unknown;
  content?: { body: string; type: "html" | "text" } | undefined;
  author?: { email?: string; name?: string } | undefined;
}
interface FrontConversation {
  id: string;
  subject?: string | undefined;
  recipient?: FrontRecipient | undefined;
  assignee?: { email?: string; name?: string } | undefined;
  tags: ReadonlyArray<{ name: string }>;
  customFieldAttributes: ReadonlyArray<{ name: string; value: unknown }>;
  draftId?: string | undefined;
}
interface FrontContextBase {
  type: string;
  teammate: { email: string; name: string };
  conversation?: FrontConversation | undefined;
  listMessages(): Promise<{ results?: ReadonlyArray<FrontMessage> } | ReadonlyArray<FrontMessage>>;
  listComments(): Promise<{ results?: ReadonlyArray<FrontComment> } | ReadonlyArray<FrontComment>>;
}
interface SingleConversationContext extends FrontContextBase {
  type: "singleConversation";
  conversation: FrontConversation;
  fetchDraft(draftId: string): Promise<{ content: { body: string } } | undefined>;
}
interface MessageComposerContext extends FrontContextBase {
  type: "messageComposer";
  draft: { id: string; content: { body: string; type: "html" | "text" } };
  conversation: FrontConversation | undefined;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function asArray<T>(page: { results?: ReadonlyArray<T> } | ReadonlyArray<T>): T[] {
  if (Array.isArray(page)) return [...page];
  const results = (page as { results?: ReadonlyArray<T> }).results;
  return [...(results ?? [])];
}

function isoDate(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const d = v instanceof Date ? v : new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function main(): Promise<void> {
  // Front plugins are configured through their install URL; settings ride as query params.
  const params = new URLSearchParams(location.search);
  const raw: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) raw[k] = v;
  const settings: AppSettings = settingsFrom(raw);
  const apiKey = typeof raw.overturn_api_key === "string" ? raw.overturn_api_key : "";
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app")!;
  const status = el("div", { class: "status" }, "Waiting for a draft");
  // One click picks the reason (what the scorecard counts); the note is optional detail.
  let reasonCode: string | null = null;
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  for (const q of quickReasons(settings)) {
    const b = el(
      "button",
      { type: "button", class: "chip", "data-code": q.code },
      q.label,
    ) as HTMLButtonElement;
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
      void flushPending();
    });
    chips.push(b);
    quick.appendChild(b);
  }
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, mark, note);

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  let ctx: FrontContextBase | null = null;
  let conversationId: string | null = null;
  let lastSentId: string | null = null;
  let draftFields: Record<string, unknown> = {};
  // A changed send whose capture is held until the agent picks a reason (Front cannot
  // block the send itself, so require_reason gates the capture, never the send).
  let pending: {
    conversation: ConversationSnapshot;
    sendText: string;
    fields: Record<string, unknown>;
  } | null = null;

  const readFields = (conversation: FrontConversation): Record<string, unknown> => {
    if (settings.decisionFields.length === 0) return {};
    const byName = new Map(conversation.customFieldAttributes.map((a) => [a.name, a.value]));
    return Object.fromEntries(settings.decisionFields.map((f) => [f.label, byName.get(f.id) ?? null]));
  };

  const snapshot = async (
    c: FrontContextBase,
    conversation: FrontConversation,
  ): Promise<ConversationSnapshot> => {
    const [messages, comments] = await Promise.all([
      c
        .listMessages()
        .then(asArray)
        .catch(() => [] as FrontMessage[]),
      c
        .listComments()
        .then(asArray)
        .catch(() => [] as FrontComment[]),
    ]);
    const rows: ConversationSnapshot["messages"] = [
      ...messages.map((m) => ({
        id: m.id,
        body: m.content?.body ?? "",
        type: "message",
        authorName: m.from.name ?? null,
        authorEmail: m.from.handle ?? null,
        isAgent: m.from.handle === c.teammate.email,
        createdAt: isoDate(m.date),
      })),
      ...comments.map((cm) => ({
        id: cm.id,
        body: cm.content?.body ?? "",
        type: "comment",
        authorName: cm.author?.name ?? null,
        authorEmail: cm.author?.email ?? null,
        isAgent: true,
        createdAt: isoDate(cm.postedAt),
      })),
    ].sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
    return {
      id: conversation.id,
      subject: conversation.subject ?? null,
      contactEmail: conversation.recipient?.handle ?? null,
      contactName: conversation.recipient?.name ?? null,
      messages: rows,
      fields: readFields(conversation),
      url: `https://app.frontapp.com/open/${conversation.id}`,
    };
  };

  const postCapture = async (body: unknown): Promise<void> => {
    const r = await fetch(`${settings.baseUrl}/v1/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const result = (await r.json()) as CaptureResult;
    lastResult = { kind: result.kind, changed: result.changed, dedup: result.deduplicated };
    note.textContent = result.changed && result.case ? `Case: ${result.case.title}` : "";
    reason.value = "";
    reasonCode = null;
    for (const c of chips) c.classList.remove("on");
    detector.set(null);
    pending = null;
    render();
  };

  async function flushPending(): Promise<void> {
    if (!pending || !ctx) return;
    const decision = decideOnSend({
      conversation: pending.conversation,
      draft: detector.current(),
      draftFields,
      send: { text: pending.sendText, type: "reply", fields: pending.fields },
      reasonCode,
      reason: reason.value,
      actor: ctx.teammate.email,
      settings,
      now: Date.now(),
    });
    if (decision.action !== "capture") return;
    pending = null;
    try {
      await postCapture(decision.body);
    } catch {
      note.textContent = "Overturn could not save this correction (network).";
    }
  }

  /** The newest teammate message in the conversation, if it is one we have not handled. */
  const checkForSend = async (c: FrontContextBase, conversation: FrontConversation): Promise<void> => {
    const draft: DraftState | null = detector.current();
    if (!draft) return;
    const messages = await c
      .listMessages()
      .then(asArray)
      .catch(() => [] as FrontMessage[]);
    const mine = messages.filter((m) => m.from.handle === c.teammate.email);
    const newest = mine[mine.length - 1];
    if (!newest || newest.id === lastSentId) return;
    lastSentId = newest.id;
    const snap = await snapshot(c, conversation);
    const decision = decideOnSend({
      conversation: snap,
      draft,
      draftFields,
      send: { text: newest.content?.body ?? "", type: "reply", fields: snap.fields },
      reasonCode,
      reason: reason.value,
      actor: c.teammate.email,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") return;
    if (decision.action === "need-reason") {
      // The reply is already gone — Front gives a plugin no way to hold it, and the spec
      // says a capture must never block the send. Hold the capture instead: it posts the
      // moment the agent picks the reason.
      pending = { conversation: snap, sendText: newest.content?.body ?? "", fields: snap.fields };
      note.textContent = "Pick why you changed it above — the capture is held until you do.";
      chips[0]?.focus();
      return;
    }
    try {
      await postCapture(decision.body);
    } catch {
      // Never block the agent's work on our failure; say so in the panel.
      note.textContent = "Overturn could not save this correction (network).";
    }
  };

  const onConversation = async (c: FrontContextBase, conversation: FrontConversation): Promise<void> => {
    if (conversationId !== conversation.id) {
      conversationId = conversation.id;
      lastSentId = null;
      pending = null;
      detector.set(null);
      draftFields = readFields(conversation);
      // Baseline: the newest teammate message predates us; never capture it as a send.
      const messages = await c
        .listMessages()
        .then(asArray)
        .catch(() => [] as FrontMessage[]);
      const mine = messages.filter((m) => m.from.handle === c.teammate.email);
      lastSentId = mine[mine.length - 1]?.id ?? null;
      // A drafting agent that recorded its run with the SDK: the draft is its output.
      if (apiKey) {
        try {
          const res = await fetch(
            `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`fr:${conversation.id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
            { headers: { Authorization: `Bearer ${apiKey}` } },
          );
          if (res.ok) {
            const found = (await res.json()) as { items?: Array<{ id: string; output: unknown }> };
            const run = found.items?.[0];
            if (run && typeof run.output === "string" && run.output.trim()) {
              detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
            }
          }
        } catch {
          // no recorded draft; the composer is watched instead
        }
      }
      render();
    }
    draftFields = readFields(conversation);
  };

  mark.addEventListener("click", async () => {
    if (!ctx) return;
    let text: string | null = null;
    if (ctx.type === "messageComposer") {
      text = stripHtml((ctx as MessageComposerContext).draft.content.body);
    } else if (ctx.type === "singleConversation") {
      const sc = ctx as SingleConversationContext;
      const draftId = sc.conversation.draftId;
      if (draftId) {
        const d = await sc.fetchDraft(draftId).catch(() => undefined);
        if (d) text = stripHtml(d.content.body);
      }
    }
    if (!text?.trim()) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });

  contextUpdates.subscribe((raw) => {
    const c = raw as unknown as FrontContextBase;
    if (c.type !== "singleConversation" && c.type !== "messageComposer") return;
    ctx = c;
    const conversation = c.conversation;
    if (!conversation) return;
    // Scope: with a tag configured, a conversation without it is never read.
    if (
      settings.scopeTag &&
      !inScope(
        conversation.tags.map((t) => t.name),
        settings,
      )
    ) {
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
      quick.remove();
      reason.remove();
      mark.remove();
      return;
    }
    void (async () => {
      await onConversation(c, conversation);
      if (c.type === "messageComposer") {
        const body = stripHtml((c as MessageComposerContext).draft.content.body);
        if (detector.onComposer(body)) render();
      }
      await checkForSend(c, conversation);
    })();
  });

  render();
}

void main();
