import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  type TicketSnapshot,
} from "./capture";

/** Minimal Gorgias widget: embeds Overturn capture logic into a ticket reply composer.
 *  Mirrors the zendesk-app structure, adapted for Gorgias iframe.
 */
interface GorgiasWindow {
  on: (event: string, handler: (data?: unknown) => unknown) => void;
  request: <T = Record<string, unknown>>(opts: Record<string, unknown>) => Promise<T>;
  metadata: () => Promise<{ settings: Record<string, unknown} }>;
  context: () => Promise<Record<string, unknown>>;
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

function renderStatus(root: HTMLElement, text: string): void {
  const status = el("div", { class: "status" }, text);
  root.appendChild(status);
}

function renderQuickReasons(root: HTMLElement, codes: ReadonlyArray<{ code: string; label: string }>): void {
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  for (const q of codes) {
    const b = el("button", {
      type: "button", class: "chip", "data-code": q.code,
    }, q.label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      for (const c of chips) c.classList.toggle("on", c.dataset.code === q.code);
    });
    chips.push(b);
    quick.appendChild(b);
  }
  root.appendChild(quick);
}

function renderReason(root: HTMLElement): HTMLTextAreaElement {
  const reason = el("textarea", {
    class: "reason", rows: "2", placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  root.appendChild(reason);
  return reason;
}

function renderNote(root: HTMLElement): HTMLDivElement {
  const note = el("div", { class: "note" }, "");
  root.appendChild(note);
  return note;
}

async function main(): Promise<void> {
  // We cannot init ZAFClient in an iframe sandboxed to Gorgias; instead read settings
  // from a data-attribute baked into the page by the host, or fall back to defaults.
  const settingsRaw = (self as any).overturnSettings ?? {};
  const settings: AppSettings = settingsFrom(settingsRaw);

  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars ?? 80 });

  const root = document.getElementById("app")! as HTMLElement;
  renderStatus(root, "Waiting for a draft");

  // The host (Gorgias) should expose `window.overturnSettings` with { minDraftChars, agent, ... }
  // One-click reasons from the shared library
  const reasonCodes = quickReasons(settings);
  renderQuickReasons(root, reasonCodes);

  const reasonText = renderReason(root);
  const note = renderNote(root);

  // Resize the iframe so the host sees the full height
  try {
    const evt = new MessageEvent("resize", { data: { width: "100%", height: "auto" }, origin: "*" });
    window.dispatchEvent(evt);
  } catch {}

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  let reasonCode: string | null = null;

  // When the agent types or clicks, decide whether to capture
  async function onSubmit(): Promise<boolean> {
    const composerText = reasonText.value.trim();
    if (!composerText) {
      renderStatus(root, "Type a draft first");
      return false;
    }

    const input = {
      ticket: {
        id: (self as any).overturnTicketId ?? 0,
        subject: (self as any).overturnTicketSubject ?? "Untitled",
        requesterEmail: (self as any).overturnRequesterEmail ?? null,
        requesterName: (self as any).overturnRequesterName ?? null,
        comments: [],
        fields: {},
        url: (self as any).overturnTicketUrl ?? "",
      } as TicketSnapshot,
      composerText,
      now: Date.now(),
      actor: (self as any).overturnActor ?? "gorgias-agent",
      settings,
    };

    const decision = decideOnSend(input as any);
    reasonCode = decision.reasonCode ?? null;

    if (decision.action === "skip") {
      renderStatus(root, "No draft detected");
      return true;
    }
    if (decision.action === "need-reason") {
      renderStatus(root, "Pick a reason (one click)");
      return false; // block submit
    }

    // action === "capture"
    const body: any = decision.body ?? {};
    try {
      // The host API endpoint
      const r = await (self as any).overturnRequest?.({
        url: (settings?.overturn_base_url ?? "https://api.overturn.run") + "/v1/capture",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${settings?.overturn_api_key ?? ""}`,
        },
        body: JSON.stringify(body),
      });
      lastResult = { kind: r.kind ?? "capture", changed: !!r.changed, dedup: false };
      note.textContent = r.changed && r.case ? `Case: ${r.case.title ?? ""}` : "";
      reasonText.value = "";
      reasonCode = null;
      for (const c of document.querySelectorAll(".chip")) c.classList.remove("on");
      renderStatus(root, `Captured ${lastResult.changed ? "with case" : ""}`);
    } catch (e: any) {
      note.textContent = `Overturn error: ${e.status ?? e.message ?? "unknown"}`;
      renderStatus(root, `Could not save correction`);
    }
    return true;
  }

  // Expose to the host
  ;(self as any).overturnSubmit = onSubmit;
}

void main();
