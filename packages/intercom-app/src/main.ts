import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  quickReasons,
  settingsFrom,
  statusLine,
  type ConversationSnapshot,
} from "./capture";

/** The slice of the Intercom Canvas Kit SDK this app uses. */
interface IntercomClient {
  on(event: string, handler: (data?: unknown) => unknown): void;
  get<T = Record<string, unknown>>(paths: string | string[]): Promise<T>;
  request<T = unknown>(opts: Record<string, unknown>): Promise<T>;
}

declare global {
  interface Window {
    intercom: {
      on(event: string, handler: (data?: unknown) => void): void;
      get(): Promise<Record<string, unknown>>;
    };
  }
}

interface IntercomConversation {
  id: string;
  subject: string | null;
  contact?: { email?: string; name?: string } | null;
}

interface IntercomComment {
  id?: string | number;
  body: string;
  type: "comment" | "note" | string;
  author?: { name?: string; email?: string; role?: string };
  createdAt?: string;
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

async function main(): Promise<void> {
  const meta = await window.intercom.get();
  const settings: AppSettings = settingsFrom(meta.settings ?? {});
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app")!;
  const status = el("div", { class: "status" }, "Waiting for a draft");
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

  const conversationId = (meta as { conversation?: { id?: string } }).conversation?.id;
  if (!conversationId) {
    status.textContent = "No conversation available";
    quick.remove();
    reason.remove();
    mark.remove();
    return;
  }

  // A drafting agent that recorded its run with the SDK: the draft is its output.
  try {
    const found = await window.intercom.request<{ items: Array<{ id: string; output: unknown; agent: string }> }>({
      url: `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`ic:${conversationId}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
      method: "GET",
      headers: { Authorization: "Bearer {{setting.overturn_api_key}}" },
    });
    const run = found.items[0];
    if (run && typeof run.output === "string" && run.output.trim()) {
      detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
    }
  } catch {
    // no recorded draft; the composer is watched instead
  }

  const composer = await window.intercom.get<{ body?: string }>();
  detector.onComposer(composer.body ?? "");
  window.intercom.on("body.changed", (text) => {
    if (detector.onComposer(typeof text === "string" ? text : "")) render();
  });
  mark.addEventListener("click", async () => {
    const now = await window.intercom.get<{ body?: string }>();
    const text = now.body ?? "";
    if (!text.trim()) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });
  render();

  const readFields = async (): Promise<Record<string, unknown>> => {
    if (settings.decisionFields.length === 0) return {};
    return {};
  };
  const draftFields = await readFields();

  const sendCapture = async (sendText: string, sendType: string) => {
    const draft: DraftState | null = detector.current();
    if (!draft) return true;
    if (sendType === "note" && !settings.captureInternalNotes) return true;
    const conversation: ConversationSnapshot = {
      id: conversationId,
      subject: (meta as { subject?: string }).subject ?? null,
      requesterEmail: (meta as { contact?: { email?: string } }).contact?.email ?? null,
      requesterName: (meta as { contact?: { name?: string } }).contact?.name ?? null,
      comments: [],
      fields: await readFields(),
      url: null,
    };
    const decision = decideOnSend({
      conversation,
      draft,
      draftFields,
      send: { text: sendText, type: sendType as "comment" | "note", fields: {} },
      reasonCode,
      reason: reason.value,
      actor: null,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") return true;
    if (decision.action === "need-reason") {
      chips[0]?.focus();
      throw `Overturn: pick why you changed the reply in the Overturn panel (one click).`;
    }
    try {
      const r = await window.intercom.request<CaptureResult>({
        url: `${settings.baseUrl}/v1/capture`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer {{setting.overturn_api_key}}",
        },
        body: JSON.stringify(decision.body),
      });
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      detector.set(null);
      render();
    } catch (e) {
      note.textContent = `Overturn could not save this correction (${(e as { status?: number }).status ?? "network"}).`;
    }
    return true;
  };

  window.intercom.on("send", async (payload) => {
    const text = (payload as { body?: string }).body ?? "";
    await sendCapture(text, "comment");
  });

  render();
}

void main();
