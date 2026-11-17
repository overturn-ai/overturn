import { createDraftDetector, decideOnSend, quickReasons, settingsFrom, statusLine, type DraftState, type TicketSnapshot } from "./capture";

/** Content script: reads only the active ticket and never cancels or awaits a Gorgias send. */
interface Config extends Record<string, unknown> { overturn_api_key?: string; overturn_base_url?: string; agent?: string; reason_pack?: string; require_reason?: boolean; min_draft_chars?: string; capture_internal_notes?: boolean }
declare const chrome: {
  storage: { local: { get(keys: string[], callback: (values: Config) => void): void } };
  runtime: { sendMessage(message: { type: string; body: unknown }, callback: (result: { ok: boolean; changed?: boolean; dedup?: boolean; error?: string } | undefined) => void): void };
};
const configKeys: string[] = ["overturn_api_key", "overturn_base_url", "agent", "reason_pack", "require_reason", "min_draft_chars", "capture_internal_notes"];
const composerSelector = '[data-testid="message-composer"] [contenteditable="true"], [data-testid="reply-editor"] [contenteditable="true"], [data-testid="message-composer"] textarea, [data-testid="reply-editor"] textarea, [contenteditable="true"][role="textbox"]';
const sendSelector = '[data-testid="send-button"], [data-testid="send-message-button"], button[aria-label="Send"], button[aria-label="Send message"]';
const readText = (node: Element): string => node instanceof HTMLTextAreaElement ? node.value : node.innerHTML;
const ticketId = (): string | null => location.pathname.match(/\/(?:app\/)?tickets?\/(\d+)(?:\/|$)/)?.[1] ?? null;
const editor = (): Element | null => document.querySelector(composerSelector);
function snapshot(id: string): TicketSnapshot {
  const root = document.querySelector('[data-testid="ticket-conversation"]') ?? document.querySelector("main");
  const messages = Array.from(root?.querySelectorAll('[data-testid="ticket-message"], [data-testid="message-item"]') ?? []).map((node) => ({
    body: node.querySelector('[data-testid="message-body"]')?.innerHTML ?? node.textContent ?? "",
    fromAgent: node.matches('[data-direction="outgoing"]') || node.getAttribute("data-sent-by") === "agent",
    internal: node.getAttribute("data-internal") === "true",
    author: node.querySelector('[data-testid="message-author"]')?.textContent?.trim() ?? null,
    at: node.querySelector("time")?.getAttribute("datetime") ?? null,
  }));
  const order: Record<string, string> = {};
  for (const key of ["id", "status", "tracking", "total", "fulfillment"]) {
    const value = document.querySelector(`[data-testid="order-${key}"]`)?.textContent?.trim();
    if (value) order[key] = value;
  }
  return {
    id, subject: document.querySelector('[data-testid="ticket-subject"]')?.textContent?.trim() ?? null,
    url: location.href, customerEmail: document.querySelector('[data-testid="customer-email"]')?.textContent?.trim() ?? null,
    order: Object.keys(order).length ? order : null, messages,
  };
}
function mount(): void {
  let activeId: string | null = null;
  let lastEditor: Element | null = null;
  let observer: MutationObserver | null = null;
  let detector = createDraftDetector({ minDraftChars: 80 });
  let reasonCode: string | null = null;
  let settings = settingsFrom({});
  let lastResult: { changed: boolean; dedup: boolean } | null = null;
  const panel = document.createElement("section");
  panel.id = "overturn-gorgias-panel";
  panel.setAttribute("aria-label", "Overturn capture");
  panel.innerHTML = '<strong class="status">Waiting for a draft</strong><div class="quick" role="group" aria-label="Reason for changing the draft"></div><textarea class="reason" rows="2" placeholder="Optional note"></textarea><button type="button" class="mark">Use current text as draft</button><p class="note" aria-live="polite"></p>';
  const status = panel.querySelector<HTMLElement>(".status")!;
  const quick = panel.querySelector<HTMLElement>(".quick")!;
  const reason = panel.querySelector<HTMLTextAreaElement>(".reason")!;
  const note = panel.querySelector<HTMLElement>(".note")!;
  const render = (): void => { status.textContent = statusLine(detector.current(), lastResult); };
  const chips = (): void => {
    quick.replaceChildren();
    for (const option of quickReasons(settings)) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = option.label; button.dataset.code = option.code;
      button.addEventListener("click", () => {
        reasonCode = reasonCode === option.code ? null : option.code;
        for (const chip of Array.from(quick.querySelectorAll("button"))) chip.classList.toggle("on", chip.getAttribute("data-code") === reasonCode);
      });
      quick.append(button);
    }
  };
  panel.querySelector<HTMLButtonElement>(".mark")!.addEventListener("click", () => {
    const text = editor();
    if (!text || !readText(text).trim()) return;
    detector.set({ text: readText(text), origin: "manual", at: Date.now() });
    lastResult = null; render();
  });
  chrome.storage.local.get(configKeys, (config: Config) => { settings = settingsFrom(config); detector = createDraftDetector({ minDraftChars: settings.minDraftChars }); observer?.disconnect(); lastEditor = null; chips(); refresh(); });
  function refresh(): void {
    const id = ticketId();
    if (id !== activeId) {
      activeId = id; lastResult = null; reasonCode = null; reason.value = ""; note.textContent = "";
      observer?.disconnect(); lastEditor = null;
      detector = createDraftDetector({ minDraftChars: settings.minDraftChars }); chips(); render();
    }
    if (!id) { panel.remove(); return; }
    if (!panel.isConnected) (document.querySelector('[data-testid="ticket-sidebar"]') ?? document.querySelector("aside") ?? document.body).prepend(panel);
    const current = editor();
    if (current !== lastEditor) {
      observer?.disconnect(); lastEditor = current;
      if (current) {
        if (detector.onComposer(readText(current))) render();
        observer = new MutationObserver(() => { if (detector.onComposer(readText(current))) render(); });
        observer.observe(current, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["value"] });
        current.addEventListener("input", () => { if (detector.onComposer(readText(current))) render(); });
      }
    }
  }
  function onSend(target: EventTarget | null): void {
    if (!activeId || !detector.current()) return;
    const current = editor(); if (!current) return;
    const button = target instanceof Element ? target.closest("button") : null;
    const internal = button?.getAttribute("data-internal") === "true";
    let ticket: TicketSnapshot;
    try { ticket = snapshot(activeId); } catch { note.textContent = "Overturn could not read ticket context; your reply is not affected."; return; }
    const draft: DraftState | null = detector.current();
    const decision = decideOnSend({ ticket, draft, sentText: readText(current), draftFields: {}, sentFields: {}, reasonCode, reason: reason.value, actor: null, settings, internal });
    if (decision.action === "skip") return;
    if (decision.action === "need-reason") {
      note.textContent = "Select a reason before sending to capture this edit. Your send was not blocked.";
      return;
    }
    // Capture the payload synchronously; the background worker performs the network request.
    // Never preventDefault, stopPropagation, or await a network request in the send path.
    chrome.runtime.sendMessage({ type: "capture", body: decision.body }, (response: { ok: boolean; changed?: boolean; dedup?: boolean; error?: string } | undefined) => {
      if (!response?.ok) { note.textContent = `Overturn capture failed (${response?.error ?? "network"}); the reply was not affected.`; return; }
      if (activeId !== String(ticket.id)) return;
      lastResult = { changed: response.changed ?? false, dedup: response.dedup ?? false };
      reason.value = ""; reasonCode = null; detector.set(null); chips(); render();
    });
  }
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(sendSelector)) onSend(event.target);
  }, true);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && event.target instanceof Element && event.target.closest(composerSelector)) onSend(event.target);
  }, true);
  // Gorgias is a SPA; poll only the active ticket/editor identity (not historical threads).
  setInterval(refresh, 500);
  refresh();
}
mount();
