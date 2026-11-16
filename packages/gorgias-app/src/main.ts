import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  extractOrderFields,
  inScope,
  quickReasons,
  settingsFrom,
  statusLine,
  type TicketSnapshot,
} from "./capture";

/** Gorgias parent window messaging protocol interface. */
interface GorgiasClient {
  on(event: string, handler: (data?: unknown) => unknown): void;
  get<T = Record<string, unknown>>(path: string): Promise<T>;
  request<T = unknown>(opts: {
    url: string;
    method?: string;
    type?: string;
    headers?: Record<string, string>;
    data?: string;
    contentType?: string;
  }): Promise<T>;
  resize?(dims: { width?: string; height?: string }): void;
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

/** Resolves URL query parameters (standard way Gorgias passes settings and context to iframe widgets). */
function parseUrlParams(): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (typeof window === "undefined" || !window.location) return params;
  const search = new URLSearchParams(window.location.search);
  for (const [k, v] of search.entries()) {
    params[k] = v;
  }
  return params;
}

/** Minimal Gorgias bridge to listen to postMessages and communicate with the helpdesk. */
function createGorgiasBridge(): GorgiasClient {
  const listeners: Record<string, Array<(data?: unknown) => unknown>> = {};

  if (typeof window !== "undefined") {
    window.addEventListener("message", (event: MessageEvent) => {
      try {
        const payload = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (payload && typeof payload === "object" && typeof payload.type === "string") {
          const handlers = listeners[payload.type] || [];
          for (const h of handlers) h(payload.data);
        }
      } catch {
        // Ignore unparseable external messages
      }
    });
  }

  return {
    on(event: string, handler: (data?: unknown) => unknown): void {
      if (!listeners[event]) listeners[event] = [];
      listeners[event]?.push(handler);
    },
    async get<T = Record<string, unknown>>(_path: string): Promise<T> {
      return {} as T;
    },
    async request<T = unknown>(opts: {
      url: string;
      method?: string;
      type?: string;
      headers?: Record<string, string>;
      data?: string;
      contentType?: string;
    }): Promise<T> {
      const method = opts.method || opts.type || "GET";
      const headers: Record<string, string> = {
        Accept: "application/json",
        ...(opts.contentType ? { "Content-Type": opts.contentType } : {}),
        ...(opts.headers ?? {}),
      };
      const res = await fetch(opts.url, {
        method,
        headers,
        body: method !== "GET" && method !== "HEAD" ? opts.data : undefined,
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        (err as { status?: number }).status = res.status;
        throw err;
      }
      return (await res.json()) as T;
    },
    resize(dims: { width?: string; height?: string }): void {
      if (typeof window !== "undefined" && window.parent && window.parent !== window) {
        window.parent.postMessage(
          { type: "gorgias:widget:resize", height: dims.height, width: dims.width },
          "*",
        );
      }
    },
  };
}

async function main(): Promise<void> {
  const client = createGorgiasBridge();
  const urlParams = parseUrlParams();
  const settings: AppSettings = settingsFrom(urlParams);
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const root = document.getElementById("app")!;
  const status = el("div", { class: "status" }, "Waiting for a draft");

  // Show order context badge if available (Gorgias ecommerce priority)
  const orderBadge = el("div", { class: "order-badge", style: "display: none;" });

  let reasonCode: string | null = null;
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];

  for (const q of quickReasons(settings)) {
    const b = el(
      "button",
      { type: "button", class: "chip", "data-code": q.code },
      q.label,
    );
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
      warning.style.display = "none";
    });
    chips.push(b);
    quick.appendChild(b);
  }

  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional note.",
  });
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const warning = el("div", { class: "warning", style: "display: none;" });
  const note = el("div", { class: "note" }, "");

  root.append(status, orderBadge, quick, reason, mark, warning, note);
  client.resize?.({ width: "100%", height: "280px" });

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  const ticketId = (urlParams.ticket_id || urlParams.ticketId || "0") as string | number;
  let currentTicket: TicketSnapshot = {
    id: ticketId,
    subject: (urlParams.ticket_subject as string) || null,
    customerEmail: (urlParams.customer_email as string) || null,
    customerName: (urlParams.customer_name as string) || null,
    messages: [],
    fields: {},
    url: typeof window !== "undefined" ? window.location.href : null,
  };

  // Check order context from parameters
  const orderContext = extractOrderFields(currentTicket, settings.orderFields);
  if (Object.keys(orderContext).length > 0) {
    const orderNum = orderContext.order_number || orderContext.order_id || "";
    orderBadge.textContent = `Order ${orderNum}`;
    orderBadge.style.display = "inline-flex";
  }

  // Scope check
  if (settings.scopeTag) {
    const rawTags = (urlParams.tags as string) || "";
    const tags = rawTags.split(",").map((s) => s.trim()).filter(Boolean);
    if (!inScope(tags, settings)) {
      status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
      quick.remove();
      reason.remove();
      mark.remove();
      warning.remove();
      return;
    }
  }

  // A drafting agent that recorded its run with the SDK: the draft is its output.
  const apiKey = (urlParams.overturn_api_key || urlParams.apiKey) as string | undefined;
  if (apiKey) {
    try {
      const found = await client.request<{ items: Array<{ id: string; output: unknown; agent: string }> }>({
        url: `${settings.baseUrl}/v1/runs?externalId=${encodeURIComponent(`gr:${ticketId}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
        type: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const run = found.items[0];
      if (run && typeof run.output === "string" && run.output.trim()) {
        detector.set({ text: run.output, origin: "recorded", runId: run.id, at: Date.now() });
        render();
      }
    } catch {
      // no recorded draft found; composer is watched instead
    }
  }

  // Listen for composer changes from Gorgias host
  client.on("gorgias:composer:changed", (data: unknown) => {
    const text = typeof data === "string" ? data : (data as { text?: string })?.text ?? "";
    if (detector.onComposer(text)) render();
  });

  // Listen for ticket snapshot updates from Gorgias host
  client.on("gorgias:ticket:loaded", (data: unknown) => {
    if (data && typeof data === "object") {
      currentTicket = { ...currentTicket, ...(data as TicketSnapshot) };
      const orders = extractOrderFields(currentTicket, settings.orderFields);
      if (Object.keys(orders).length > 0) {
        orderBadge.textContent = `Order ${orders.order_number || orders.order_id || ""}`;
        orderBadge.style.display = "inline-flex";
      }
    }
  });

  mark.addEventListener("click", () => {
    // Allows manually marking current text as draft
    const inputMsg = prompt("Enter or paste draft text:") ?? "";
    if (inputMsg.trim()) {
      detector.set({ text: inputMsg, origin: "manual", at: Date.now() });
      lastResult = null;
      render();
    }
  });

  // On send event: never block the send!
  client.on("gorgias:message:send", async (data: unknown) => {
    const draft: DraftState | null = detector.current();
    if (!draft) return true; // No draft to capture; never block the send

    const sendPayload = (data ?? {}) as {
      text?: string;
      channel?: string;
      type?: string;
      fields?: Record<string, unknown>;
    };

    const sendType = sendPayload.channel === "internal-note" || sendPayload.type === "internalNote"
      ? "internalNote"
      : "publicReply";

    if (sendType === "internalNote" && !settings.captureInternalNotes) {
      return true;
    }

    const decision = decideOnSend({
      ticket: currentTicket,
      draft,
      draftFields: currentTicket.fields,
      send: {
        text: sendPayload.text ?? "",
        type: sendType,
        fields: sendPayload.fields ?? currentTicket.fields,
      },
      reasonCode,
      reason: reason.value,
      actor: (urlParams.current_user_email as string) || null,
      settings,
      now: Date.now(),
    });

    if (decision.action === "skip") return true;

    if (decision.action === "need-reason") {
      // Prompt the user in the panel without blocking the send
      warning.textContent = "Please pick a reason for the changed reply.";
      warning.style.display = "block";
      chips[0]?.focus();
      // Requirement 5: NEVER BLOCK THE SEND. We return true so send goes through!
      return true;
    }

    // Capture the correction
    try {
      const r = await client.request<CaptureResult>({
        url: `${settings.baseUrl}/v1/capture`,
        type: "POST",
        contentType: "application/json",
        data: JSON.stringify(decision.body),
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      });
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
      warning.style.display = "none";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      detector.set(null);
      render();
    } catch (e) {
      // Overturn failing never blocks the send
      note.textContent = `Overturn could not save this correction (${(e as { status?: number }).status ?? "network"}).`;
    }

    return true;
  });

  render();
}

void main();
