import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createDraftDetector,
  decideOnSend,
  type DraftState,
  type GorgiasTicketSnapshot,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";

export interface GorgiasRequestOptions {
  url: string;
  type?: string;
  method?: string;
  headers?: Record<string, string>;
  data?: string;
  body?: string;
  contentType?: string;
}

/** Client interface for Gorgias iframe/widget bridge. */
export interface GorgiasClient {
  on(event: string, handler: (data?: unknown) => unknown): void;
  get<T = Record<string, unknown>>(path: string): Promise<T>;
  request<T = unknown>(opts: GorgiasRequestOptions): Promise<T>;
  metadata?(): Promise<{ settings?: Record<string, unknown> }>;
}

declare global {
  interface Window {
    GorgiasClient?: GorgiasClient;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Fallback client using standard browser fetch and window message events. */
function createDefaultClient(): GorgiasClient {
  const handlers: Record<string, Array<(data?: unknown) => unknown>> = {};

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event) => {
      const data = event.data as { type?: string; payload?: unknown } | undefined;
      if (data && typeof data.type === "string") {
        const list = handlers[data.type];
        if (list) {
          for (const fn of list) fn(data.payload);
        }
      }
    });
  }

  return {
    on(event: string, handler: (data?: unknown) => unknown) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    async get<T = Record<string, unknown>>(_path: string): Promise<T> {
      return {} as T;
    },
    async request<T = unknown>(opts): Promise<T> {
      const method = (opts.method ?? opts.type ?? "GET").toUpperCase();
      const res = await fetch(opts.url, {
        method,
        headers: {
          "Content-Type": opts.contentType ?? "application/json",
          ...(opts.headers ?? {}),
        },
        body: opts.data ?? opts.body,
      });
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      return (await res.json()) as T;
    },
    async metadata() {
      // Parse settings from URL search params or data attributes
      const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const settings: Record<string, unknown> = {};
      if (params) {
        for (const [k, v] of params.entries()) {
          settings[k] = v;
        }
      }
      return { settings };
    },
  };
}

async function main(): Promise<void> {
  const client: GorgiasClient = window.GorgiasClient ?? createDefaultClient();
  const meta = client.metadata ? await client.metadata() : { settings: {} };
  const settings: AppSettings = settingsFrom(meta.settings ?? {});
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app");
  if (!root) return;

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

  const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const ticketIdFromUrl = params?.get("ticket_id") ?? params?.get("ticketId") ?? "0";
  let ticketId: number | string = Number(ticketIdFromUrl) || ticketIdFromUrl;

  try {
    const fetchedId = await client.get<{ id?: number | string; ticketId?: number | string }>("ticket.id");
    ticketId = fetchedId.id ?? fetchedId.ticketId ?? ticketId;
  } catch {
    // URL param fallback
  }

  // Scope: with a tag configured, tickets without it are never watched
  if (settings.scopeTag) {
    let tags: string[] = [];
    try {
      const data = await client.get<{ tags?: string[] }>("ticket.tags");
      tags = data.tags ?? [];
    } catch {
      // no tags
    }
    if (!inScope(tags, settings)) {
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
      quick.remove();
      reason.remove();
      mark.remove();
      return;
    }
  }

  // Look for an SDK-recorded draft run for this ticket
  const apiKey = (meta.settings?.overturn_api_key as string | undefined) ?? "";
  if (apiKey && ticketId) {
    try {
      const found = await client.request<{ items: Array<{ id: string; output: unknown; agent: string }> }>({
        url: `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`gr:${ticketId}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
        type: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const run = found.items[0];
      if (run && typeof run.output === "string" && run.output.trim()) {
        detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
      }
    } catch {
      // Composer will be watched instead
    }
  }

  // Composer monitoring
  let currentComposerText = "";
  try {
    const composer = await client.get<{ text?: string }>("ticket.comment.text");
    currentComposerText = composer.text ?? "";
    detector.onComposer(currentComposerText);
  } catch {
    // not ready yet
  }

  client.on("ticket.comment.text.changed", (data: unknown) => {
    const text = typeof data === "string" ? data : (data as { text?: string } | undefined)?.text ?? "";
    currentComposerText = text;
    if (detector.onComposer(text)) render();
  });

  mark.addEventListener("click", () => {
    if (!currentComposerText.trim()) return;
    detector.set({ text: currentComposerText, origin: "manual", at: Date.now() });
    lastResult = null;
    render();
  });
  render();

  // On ticket message send: capture the draft vs sent
  client.on("ticket.send", async (eventData: unknown) => {
    const draft: DraftState | null = detector.current();
    if (!draft) return true;

    const eventObj = (typeof eventData === "object" && eventData !== null ? eventData : {}) as Record<
      string,
      unknown
    >;

    let ticketData: GorgiasTicketSnapshot;
    try {
      ticketData = await client.get<GorgiasTicketSnapshot>("ticket");
    } catch {
      ticketData = {
        id: ticketId,
        subject: null,
        url: `${location.origin}/app/tickets/${ticketId}`,
      };
    }

    const sentText = (eventObj.text as string | undefined) ?? currentComposerText;
    const sendType = (eventObj.type as string | undefined) ?? (eventObj.channel as string | undefined) ?? "publicReply";

    const decision = decideOnSend({
      ticket: {
        ...ticketData,
        id: ticketId,
        url: ticketData.url ?? `${location.origin}/app/tickets/${ticketId}`,
      },
      draft,
      draftFields: ticketData.fields ?? ticketData.custom_fields ?? {},
      send: {
        text: sentText,
        type: sendType,
        fields: (eventObj.fields as Record<string, unknown> | undefined) ?? ticketData.fields ?? {},
      },
      reasonCode,
      reason: reason.value,
      actor: (eventObj.actor as string | undefined) ?? null,
      settings,
      now: Date.now(),
    });

    if (decision.action === "skip") return true;

    if (decision.action === "need-reason") {
      chips[0]?.focus();
      note.textContent = "Please pick a reason for the changed reply before sending.";
      // Requirement: never blocks the send
      return true;
    }

    try {
      const res = await client.request<CaptureResult>({
        url: `${settings.baseUrl}/v1/capture`,
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify(decision.body),
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      lastResult = { kind: res.kind, changed: res.changed, dedup: res.deduplicated };
      note.textContent = res.changed && res.case ? `Case: ${res.case.title}` : "";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      detector.set(null);
      render();
    } catch (e) {
      // Never block the agent's send on our failure
      const status = (e as { status?: number }).status;
      note.textContent = `Overturn could not save this correction (${status ?? "network"}).`;
    }

    return true;
  });
}

if (typeof window !== "undefined") {
  void main();
}
