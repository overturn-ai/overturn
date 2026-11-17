import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type ConversationSnapshot,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  type FrontComment,
  type FrontMessage,
  inScope,
  newlySent,
  quickReasons,
  settingsFrom,
  statusLine,
  stripHtml,
} from "./capture";

/**
 * The slice of the Front plugin SDK this plugin uses. Front injects `Front` into the plugin
 * iframe; the conversation context carries the functions that read it (`listMessages`,
 * `listComments`). Only what is used here is declared, so the app does not depend on the
 * SDK's types in its tests.
 */
interface RawRecipient {
  handle?: string;
  name?: string;
}
interface RawMessage {
  id: string;
  status?: string;
  date?: string | Date;
  content?: { body?: string; type?: string } | undefined;
  from?: RawRecipient;
}
interface RawComment {
  id: string;
  createdAt?: string | Date;
  content?: { body?: string };
  author?: { name?: string; email?: string };
}
interface RawConversation {
  id: string;
  subject?: string;
  tags?: ReadonlyArray<{ name?: string } | string>;
  recipient?: RawRecipient;
  customFieldAttributes?: ReadonlyArray<{ name?: string; value?: unknown }>;
}
interface Paginated<T> {
  results?: readonly T[];
}
interface FrontContext {
  type: string;
  conversation?: RawConversation;
  draft?: { content?: { body?: string } };
  listMessages?: (token?: string) => Promise<Paginated<RawMessage> | readonly RawMessage[]>;
  listComments?: (token?: string) => Promise<Paginated<RawComment> | readonly RawComment[]>;
}
interface Subscription {
  unsubscribe(): void;
}
interface FrontSdk {
  contextUpdates?: { subscribe(next: (context: FrontContext) => void): Subscription | undefined };
  user?: { email?: string };
  setPanelWidth?: (width: number) => void;
}

declare global {
  interface Window {
    Front?: FrontSdk;
  }
}

interface StoredSettings {
  apiKey: string;
  query: Record<string, string>;
}

const STORAGE_KEY = "overturn.front.settings";

function readQuery(): Record<string, string> {
  return Object.fromEntries(new URL(location.href).searchParams.entries());
}

function loadSettings(): StoredSettings | null {
  const query = readQuery();
  if (query.api_key) {
    const stored: StoredSettings = { apiKey: query.api_key, query };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    return stored;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSettings;
    // The URL wins for behaviour settings even after the key was stored once.
    return { apiKey: parsed.apiKey, query: { ...parsed.query, ...query } };
  } catch {
    return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function iso(value: string | Date | undefined): string | null {
  if (!value) return null;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function tagNames(conversation: RawConversation): string[] {
  return (conversation.tags ?? []).map((t) => (typeof t === "string" ? t : (t.name ?? ""))).filter(Boolean);
}

async function listAll<T>(
  fetchPage: ((token?: string) => Promise<Paginated<T> | readonly T[]>) | undefined,
): Promise<T[]> {
  if (!fetchPage) return [];
  const page = await fetchPage();
  if (Array.isArray(page)) return [...(page as readonly T[])];
  return [...(((page as Paginated<T>).results ?? []) as readonly T[])];
}

function conversationFrom(
  raw: RawConversation,
  messages: RawMessage[],
  comments: RawComment[],
): ConversationSnapshot {
  const mapped: FrontMessage[] = messages.map((m) => ({
    id: m.id,
    body: m.content?.body ?? "",
    status: m.status,
    author: m.from?.handle ?? m.from?.name ?? null,
    at: iso(m.date),
  }));
  const notes: FrontComment[] = comments.map((c) => ({
    id: c.id,
    body: c.content?.body ?? "",
    author: c.author?.email ?? c.author?.name ?? null,
    at: iso(c.createdAt),
  }));
  const fields: Record<string, unknown> = {};
  for (const attr of raw.customFieldAttributes ?? []) {
    if (attr.name) fields[attr.name] = attr.value ?? null;
  }
  return {
    id: raw.id,
    subject: raw.subject ?? null,
    recipientEmail: raw.recipient?.handle ?? null,
    recipientName: raw.recipient?.name ?? null,
    tags: tagNames(raw),
    messages: mapped,
    comments: notes,
    fields,
    url: `https://app.frontapp.com/open/${raw.id}`,
  };
}

function renderSetup(root: HTMLElement, save: (key: string) => void): void {
  const label = el("div", { class: "note" }, "Paste an Overturn API key to start capturing corrections.");
  const input = el("input", { type: "password", placeholder: "ov_…", class: "key" });
  const button = el("button", { type: "button", class: "link" }, "Save");
  button.addEventListener("click", () => {
    const key = input.value.trim();
    if (key) save(key);
  });
  root.append(label, input, button);
}

async function main(): Promise<void> {
  const front = window.Front;
  const root = document.getElementById("app")!;
  if (!front?.contextUpdates) {
    root.append(el("div", { class: "note" }, "Overturn: open this from the Front conversation sidebar."));
    return;
  }
  front.setPanelWidth?.(360);

  const stored = loadSettings();
  if (!stored) {
    renderSetup(root, (key) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ apiKey: key, query: readQuery() }));
      root.replaceChildren();
      void main();
    });
    return;
  }

  const settings: AppSettings = settingsFrom(stored.query);
  const apiKey = stored.apiKey;
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const status = el("div", { class: "status" }, "Waiting for a draft");
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const note = el("div", { class: "note" }, "");
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  let reasonCode: string | null = null;
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  /** A changed reply with no reason yet: the payload is held and posted once a chip is picked. */
  let pending: { conversation: ConversationSnapshot; draft: DraftState; sentText: string } | null = null;

  const chips: HTMLButtonElement[] = [];
  for (const q of quickReasons(settings)) {
    const chip = el(
      "button",
      { type: "button", class: "chip", "data-code": q.code },
      q.label,
    ) as HTMLButtonElement;
    chip.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
      if (pending && reasonCode) void flushPending();
    });
    chips.push(chip);
    quick.appendChild(chip);
  }
  const reason = el("textarea", { class: "reason", rows: "2", placeholder: "Anything else? Optional." });
  root.append(status, quick, reason, mark, note);

  const render = (): void => {
    status.textContent = pending
      ? `Changed · pick why before it is saved (${pending.conversation.id})`
      : statusLine(detector.current(), lastResult);
  };

  const post = async (body: unknown): Promise<CaptureResult> => {
    const response = await fetch(`${settings.baseUrl}/v1/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`capture failed (${response.status})`);
    return (await response.json()) as CaptureResult;
  };

  async function flushPending(): Promise<void> {
    if (!pending || !reasonCode) return;
    const decision = decideOnSend({
      conversation: pending.conversation,
      draft: pending.draft,
      draftFields: pending.conversation.fields,
      sent: { text: pending.sentText, fields: pending.conversation.fields },
      reasonCode,
      reason: reason.value,
      actor: front?.user?.email ?? null,
      settings,
      now: Date.now(),
    });
    if (decision.action !== "capture") return;
    try {
      const result = await post(decision.body);
      lastResult = { kind: result.kind, changed: result.changed, dedup: result.deduplicated };
      note.textContent = result.changed && result.case ? `Case: ${result.case.title}` : "";
      pending = null;
      detector.set(null);
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      render();
    } catch (error) {
      note.textContent = `Overturn could not save this correction (${error instanceof Error ? error.message : "network"}).`;
    }
  }

  let seenIds: string[] = [];
  let lastContext: FrontContext | null = null;

  const readConversation = async (context: FrontContext): Promise<ConversationSnapshot | null> => {
    const raw = context.conversation;
    if (!raw) return null;
    const [messages, comments] = await Promise.all([
      listAll(context.listMessages),
      settings.captureComments ? listAll(context.listComments) : Promise.resolve([]),
    ]);
    return conversationFrom(raw, messages, comments);
  };

  const onComposer = (context: FrontContext): void => {
    const body = context.draft?.content?.body ?? "";
    const found = detector.onComposer(body);
    if (found) {
      lastResult = null;
      render();
    }
  };

  /** The composer went away: read the thread and see whether the draft became a message. */
  const onComposerClosed = async (context: FrontContext): Promise<void> => {
    const draft = detector.current();
    if (!draft) return;
    if (!context.conversation) {
      if (lastContext?.conversation) {
        // Nothing else to read from: the sidebar lost the conversation, so drop quietly.
        detector.set(null);
        render();
      }
      return;
    }
    const conversation = await readConversation(context);
    if (!conversation) return;
    if (!inScope(conversation.tags, settings)) {
      detector.set(null);
      return;
    }
    const sent = newlySent(conversation.messages, { draftText: draft.text, draftAt: draft.at, seenIds });
    seenIds = conversation.messages.map((m) => m.id);
    if (!sent) {
      // Discarded, not sent: nothing to record, and the composer never left Front.
      detector.set(null);
      render();
      return;
    }
    const decision = decideOnSend({
      conversation,
      draft,
      draftFields: conversation.fields,
      sent: { text: sent.body, fields: conversation.fields },
      reasonCode,
      reason: reason.value,
      actor: front?.user?.email ?? null,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") {
      detector.set(null);
      render();
      return;
    }
    if (decision.action === "need-reason") {
      // Front exposes no hook to hold its own send, so the gate is on the capture: the
      // payload is held here and posted the moment a reason chip is picked.
      pending = { conversation, draft, sentText: stripHtml(sent.body) };
      chips[0]?.focus();
      note.textContent = `Pick why you changed the ${decision.changedFields.join(", ") || "reply"} — one click, then it is saved.`;
      render();
      return;
    }
    try {
      const result = await post(decision.body);
      lastResult = { kind: result.kind, changed: result.changed, dedup: result.deduplicated };
      note.textContent = result.changed && result.case ? `Case: ${result.case.title}` : "";
      detector.set(null);
      render();
    } catch (error) {
      // A failed capture never blocks the teammate's work; it says so and gets out of the way.
      note.textContent = `Overturn could not save this correction (${error instanceof Error ? error.message : "network"}).`;
      detector.set(null);
    }
  };

  mark.addEventListener("click", () => {
    const text = lastContext?.draft?.content?.body ?? "";
    if (!stripHtml(text)) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });

  front.contextUpdates.subscribe((context) => {
    const previous = lastContext;
    lastContext = context;
    if (context.type === "messageComposer") {
      onComposer(context);
      return;
    }
    if (previous?.type === "messageComposer" || detector.current()) void onComposerClosed(context);
  });
  render();
}

void main();
