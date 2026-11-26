import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  quickReasons,
  settingsFrom,
  statusLine,
  type GorgiasTicketSnapshot,
} from "./capture";

interface GorgiasClient {
  get(path: string): Promise<unknown>;
  on(event: string, handler: (payload?: unknown) => void): void;
  request<T = unknown>(opts: Record<string, unknown>): Promise<T>;
  settings(): Promise<Record<string, unknown>>;
}

declare global {
  interface Window {
    GorgiasApp?: { init(): GorgiasClient };
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

async function readSnapshot(client: GorgiasClient): Promise<GorgiasTicketSnapshot> {
  const data = (await client.get("ticket")) as Record<string, unknown>;
  const messages = Array.isArray(data.messages) ? (data.messages as GorgiasTicketSnapshot["messages"]) : [];
  return {
    id: (data.id as number | string) ?? "unknown",
    subject: (data.subject as string | null) ?? null,
    customer: (data.customer as { email?: string | null; name?: string | null } | null) ?? null,
    messages,
    fields: (data.custom_fields as Record<string, unknown> | undefined) ?? {},
    url: (data.url as string | null) ?? null,
  };
}

export async function main(): Promise<void> {
  const client = window.GorgiasApp?.init();
  if (!client) return;
  const settings: AppSettings = settingsFrom(await client.settings());
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app");
  if (!root) return;
  const status = el("div", { class: "status" }, "Waiting for a draft");
  let reasonCode: string | null = null;
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  for (const q of quickReasons(settings)) {
    const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
    });
    chips.push(b);
    quick.appendChild(b);
  }
  const reason = el("textarea", { class: "reason", rows: "2", placeholder: "Anything else? Optional." }) as HTMLTextAreaElement;
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, mark, note);

  let lastResult: { changed: boolean; dedup: boolean } | null = null;
  const render = (): void => { status.textContent = statusLine(detector.current(), lastResult); };

  client.on("replybox.change", (payload) => {
    const text = typeof payload === "string" ? payload : String((payload as { text?: unknown } | undefined)?.text ?? "");
    if (detector.onComposer(text)) render();
  });
  mark.addEventListener("click", async () => {
    const current = await client.get("replybox.text");
    const text = typeof current === "string" ? current : String((current as { text?: unknown } | undefined)?.text ?? "");
    if (!text.trim()) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });

  client.on("ticket.reply.send", async (payload) => {
    const draft: DraftState | null = detector.current();
    if (!draft) return;
    const p = (payload ?? {}) as { text?: string; html?: string; actor?: string; fields?: Record<string, unknown> };
    const ticket = await readSnapshot(client);
    const decision = decideOnSend({
      ticket,
      draft,
      draftFields: {},
      send: { text: p.text ?? p.html ?? "", fields: p.fields ?? {} },
      reasonCode,
      reason: reason.value,
      actor: p.actor ?? null,
      settings,
      now: Date.now(),
    });
    if (decision.action === "skip") return;
    if (decision.action === "need-reason") {
      chips[0]?.focus();
      note.textContent = `Pick why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"} before sending.`;
      throw new Error("Overturn: reason required");
    }
    try {
      const r = await client.request<CaptureResult>({
        url: `${settings.baseUrl}/v1/capture`,
        method: "POST",
        headers: { Authorization: `Bearer ${String((await client.settings()).overturn_api_key ?? "")}`, "Content-Type": "application/json" },
        body: JSON.stringify(decision.body),
      });
      lastResult = { changed: r.changed, dedup: r.deduplicated };
      note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      detector.set(null);
      render();
    } catch (e) {
      note.textContent = `Overturn could not save this correction (${(e as { status?: number }).status ?? "network"}).`;
    }
  });

  render();
}

void main();
