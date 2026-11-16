import type { CaptureResult } from "@overturn-ai/shared";
import {
  buildCapturePayload,
  createDraftDetector,
  type FrontConversation,
  type FrontMessage,
  plainText,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";

interface FrontDraft {
  id: string;
  content: { body: string; type: "html" | "text" };
}

interface FrontContext {
  type: string;
  teammate?: { email?: string };
  conversation?: FrontConversation;
  listMessages(paginationToken?: string): Promise<{ results: FrontMessage[]; nextPageToken?: string }>;
}

interface FrontSdk {
  contextUpdates: { subscribe(handler: (context: FrontContext) => void): { unsubscribe(): void } };
  fetchDraft(id: string): Promise<FrontDraft>;
}

declare global {
  interface Window {
    Front?: FrontSdk;
    OVERTURN_FRONT_CONFIG?: Record<string, unknown>;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function readMessages(context: FrontContext): Promise<FrontMessage[]> {
  const messages: FrontMessage[] = [];
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await context.listMessages(token);
    messages.push(...result.results);
    if (!result.nextPageToken || result.nextPageToken === token) break;
    token = result.nextPageToken;
  }
  return messages;
}

function main(): void {
  const root = document.getElementById("app");
  if (!root) return;
  const sdk = window.Front;
  if (!sdk) {
    root.textContent = "Front Plugin SDK did not load.";
    return;
  }
  const settings = settingsFrom(window.OVERTURN_FRONT_CONFIG ?? {});
  const heading = element("h1", "", "Overturn");
  const status = element("div", "status", "Select a conversation");
  const hint = element("div", "hint", "A draft must appear before the conversation is read.");
  const quick = element("div", "quick");
  quick.setAttribute("role", "radiogroup");
  quick.setAttribute("aria-label", "Why did you change the draft?");
  const chips: HTMLButtonElement[] = [];
  let reasonCode: string | null = null;
  const note = element("textarea", "") as HTMLTextAreaElement;
  note.placeholder = "Anything else? Optional.";
  const mark = element("button", "link", "Use current text as draft") as HTMLButtonElement;
  mark.type = "button";
  const feedback = element("div", "note");
  root.replaceChildren(heading, status, hint, quick, note, mark, feedback);

  let context: FrontContext | null = null;
  let conversation: FrontConversation | null = null;
  let detector = createDraftDetector(settings.minDraftChars);
  let draftId: string | null = null;
  let earlierMessages: FrontMessage[] = [];
  let earlierIds = new Set<string>();
  let pending: FrontMessage | null = null;
  let sending = false;
  let goneAt = 0;
  let polling = false;

  const render = () => {
    status.textContent = statusLine(detector.current());
    hint.textContent = pending
      ? "Sent reply found. Pick a reason to save the correction."
      : detector.current()
        ? "Choose a reason before sending if you change the draft."
        : "Waiting for a reply-sized draft.";
  };

  const submit = async (): Promise<void> => {
    if (!pending || !conversation || sending) return;
    const decision = buildCapturePayload({
      conversation,
      context: earlierMessages,
      draft: detector.current(),
      sent: pending,
      actor: context?.teammate?.email ?? null,
      reasonCode,
      reason: note.value,
      settings,
    });
    if (decision.action === "need-reason") {
      render();
      return;
    }
    if (decision.action !== "capture") return;
    sending = true;
    try {
      const response = await fetch(settings.captureUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision.body),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = (await response.json()) as CaptureResult;
      feedback.textContent = result.changed
        ? result.deduplicated
          ? "Captured · already in the suite"
          : "Captured · edit saved as a case"
        : "Sent as drafted · approved";
    } catch (error) {
      console.error("Overturn capture failed", error);
      feedback.textContent = "Overturn could not save this reply. Your Front send was unaffected.";
    } finally {
      pending = null;
      detector = createDraftDetector(settings.minDraftChars);
      draftId = null;
      reasonCode = null;
      note.value = "";
      for (const chip of chips) chip.classList.remove("on");
      sending = false;
      render();
    }
  };

  for (const option of quickReasons(settings)) {
    const chip = element("button", "", option.label) as HTMLButtonElement;
    chip.type = "button";
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
      reasonCode = reasonCode === option.code ? null : option.code;
      for (const item of chips) {
        const selected = item === chip && reasonCode === option.code;
        item.classList.toggle("on", selected);
        item.setAttribute("aria-pressed", String(selected));
      }
      void submit();
    });
    chips.push(chip);
    quick.appendChild(chip);
  }

  mark.addEventListener("click", async () => {
    if (!conversation?.draftId) return;
    try {
      const current = await sdk.fetchDraft(conversation.draftId);
      const text = plainText(current.content.body, current.content.type);
      if (!text) return;
      detector.set({ id: current.id, text, origin: "manual", at: Date.now() });
      draftId = current.id;
      const messages = context ? await readMessages(context) : [];
      earlierMessages = messages.slice(-500);
      earlierIds = new Set(messages.map((message) => message.id));
      goneAt = 0;
      render();
    } catch (error) {
      console.error("Overturn could not read the draft", error);
    }
  });

  sdk.contextUpdates.subscribe((next) => {
    const selected = next.type === "singleConversation" ? next.conversation : null;
    if (selected?.id !== conversation?.id) {
      detector = createDraftDetector(settings.minDraftChars);
      draftId = null;
      earlierMessages = [];
      earlierIds = new Set();
      pending = null;
      goneAt = 0;
      feedback.textContent = "";
    }
    context = next;
    conversation = selected ?? null;
    if (!conversation) status.textContent = "Select one conversation";
    else render();
  });

  // The Plugin SDK offers no send callback. A sidebar stays open while Front sends;
  // polling the documented draft and message methods lets us confirm the actual send.
  const poll = async () => {
    if (!context || !conversation || sending || pending || polling) return;
    polling = true;
    try {
      await pollOnce();
    } catch (error) {
      console.error("Overturn could not poll Front", error);
    } finally {
      polling = false;
    }
  };
  const pollOnce = async () => {
    if (!context || !conversation) return;
    const current = conversation;
    const selectedContext = context;
    if (current.draftId && (!draftId || current.draftId === draftId)) {
      try {
        const draft = await sdk.fetchDraft(current.draftId);
        if (conversation?.id !== current.id) return;
        const text = plainText(draft.content.body, draft.content.type);
        const found = detector.onComposer(draft.id, text);
        if (found) {
          draftId = draft.id;
          const messages = await readMessages(selectedContext);
          if (conversation?.id !== current.id) return;
          earlierMessages = messages.slice(-500);
          earlierIds = new Set(messages.map((message) => message.id));
          goneAt = 0;
          render();
        }
        return;
      } catch (error) {
        console.error("Overturn could not read the draft", error);
      }
    }
    if (!detector.current() || !draftId) return;
    if (!goneAt) goneAt = Date.now();
    try {
      const messages = await readMessages(selectedContext);
      if (conversation?.id !== current.id) return;
      const sent = messages
        .filter((message) => !earlierIds.has(message.id) && message.status === "outbound")
        .sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime())[0];
      if (!sent) {
        if (Date.now() - goneAt > 30_000) {
          detector = createDraftDetector(settings.minDraftChars);
          draftId = null;
          goneAt = 0;
          render();
        }
        return;
      }
      pending = sent;
      render();
      await submit();
    } catch (error) {
      console.error("Overturn could not confirm the sent reply", error);
    }
  };
  setInterval(() => void poll(), 1200);
}

main();
