import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { CaptureCreate } from "@overturn-ai/shared";
import {
  type AppSettings,
  decideOnSend,
  latestAgentSend,
  quickReasons,
  statusLine,
  type TicketSnapshot,
} from "./capture";
import type { GorgiasClient } from "./gorgias-client";
import type { OverturnClient } from "./overturn-client";
import { type CaptureStore, createMemoryStore, type TicketState } from "./store";
import { type WidgetData, widgetData } from "./widget";

export interface AppRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

export interface AppResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface AppDeps {
  settings: AppSettings;
  overturn: OverturnClient;
  gorgias: GorgiasClient;
  store?: CaptureStore;
  /** The public base URL of this app; the sidebar rows link back to it. */
  appBaseUrl: string;
  /** The key the Gorgias integration sends. Checked when set. */
  appKey?: string | null;
  /** Unix seconds; injected so a test can pin the clock. */
  now?: () => number;
}

function json(status: number, payload: unknown): AppResponse {
  return { status, contentType: "application/json", body: JSON.stringify(payload) };
}

function html(status: number, body: string): AppResponse {
  return { status, contentType: "text/html; charset=utf-8", body };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The ticket id, wherever Gorgias put it: the URL (the integration substitutes it), or the body. */
export function ticketIdFrom(request: AppRequest): string | null {
  const fromQuery = request.query["ticket_id"];
  if (fromQuery) return fromQuery;
  const body = request.body;
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const direct = record["ticket_id"];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (typeof direct === "number") return String(direct);
  const ticket = record["ticket"];
  if (ticket && typeof ticket === "object" && !Array.isArray(ticket)) {
    const id = (ticket as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.trim()) return id.trim();
    if (typeof id === "number") return String(id);
  }
  const id = record["id"];
  if (typeof id === "string" && id.trim()) return id.trim();
  if (typeof id === "number") return String(id);
  return null;
}

export interface TicketView {
  ticket: TicketSnapshot;
  state: TicketState;
  data: WidgetData;
}

/**
 * The app.
 *
 * Gorgias calls the integration when a ticket is created, updated or gets a new message; the
 * answer of that call is what the sidebar card shows. Nothing here ever refuses a ticket:
 * a failure is swallowed, because the agent's reply must go out whether Overturn is up or not.
 */
export function createApp(deps: AppDeps): (request: AppRequest) => Promise<AppResponse> {
  const store = deps.store ?? createMemoryStore();
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  /** Posts the capture. A failure is swallowed: the reply already went out. */
  async function post(state: TicketState, body: CaptureCreate): Promise<void> {
    try {
      const result = await deps.overturn.capture(body);
      state.lastResult = {
        kind: result.kind,
        changed: result.changed,
        dedup: result.deduplicated,
      };
      state.capturedRunId = body.draftRunId ?? null;
      state.pending = null;
    } catch {
      // The card keeps asking for the reason; the agent can click it again.
    }
  }

  async function load(ticketId: string): Promise<TicketView> {
    const ticket = await deps.gorgias.getTicket(ticketId);
    const state: TicketState = store.get(ticketId) ?? {
      draft: null,
      lastResult: null,
      pending: null,
      capturedRunId: null,
      sentAt: null,
    };
    const draft = await deps.overturn.findDraft(`gr:${ticket.id}`, deps.settings.agent);
    if (draft) state.draft = draft;

    const capturedAlready = state.lastResult !== null && state.capturedRunId === (state.draft?.runId ?? null);
    const send = latestAgentSend(ticket, state.draft, now());
    if (send && !state.pending && !capturedAlready) {
      const decision = decideOnSend({
        ticket,
        draft: state.draft,
        draftFields: {},
        send,
        reasonCode: null,
        reason: "",
        actor: ticket.assigneeEmail,
        settings: deps.settings,
        now: send.at ?? now(),
      });
      if (decision.action === "need-reason") {
        state.pending = {
          ticketId,
          body: decision.body,
          changedFields: decision.changedFields,
        };
        state.sentAt = send.at;
      } else if (decision.action === "capture") {
        await post(state, decision.body);
      }
    }
    store.set(ticketId, state);
    const data = widgetData({
      ticket,
      draft: state.draft,
      lastResult: state.lastResult,
      settings: deps.settings,
      appBaseUrl: deps.appBaseUrl,
      pendingReason: state.pending !== null,
      note: state.pending?.body.reason ?? null,
    });
    return { ticket, state, data };
  }

  /** Attaches the reason to the pending capture and sends it. */
  async function complete(state: TicketState | undefined, code: string, note: string): Promise<string> {
    if (!state?.pending) return "Nothing to capture for this ticket";
    const body: CaptureCreate = {
      ...state.pending.body,
      reasonCode: code,
      reason: note.trim() ? note.trim() : null,
    };
    await post(state, body);
    if (state.pending) return "The capture failed · click again";
    return statusLine(state.draft, state.lastResult);
  }

  function reasonForm(
    ticketId: string,
    options: readonly { code: string; label: string }[],
    note: string,
  ): string {
    const choices = options
      .map((option) => `<option value="${escapeHtml(option.code)}">${escapeHtml(option.label)}</option>`)
      .join("");
    return [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8">',
      "<title>Overturn</title>",
      "</head><body>",
      '<form method="post" action="/gorgias/reason">',
      `<input type="hidden" name="ticket_id" value="${escapeHtml(ticketId)}">`,
      '<p><label for="code">Why did you change the reply?</label></p>',
      `<select id="code" name="code">${choices}</select>`,
      '<p><label for="note">Note (optional)</label></p>',
      `<textarea id="note" name="note" rows="4">${escapeHtml(note)}</textarea>`,
      '<p><button type="submit">Capture</button></p>',
      "</form>",
      "</body></html>",
    ].join("");
  }

  function reasonPage(message: string): string {
    return [
      "<!doctype html>",
      '<html lang="en"><head><meta charset="utf-8">',
      "<title>Overturn</title>",
      "</head><body>",
      `<p>${escapeHtml(message)}</p>`,
      "</body></html>",
    ].join("");
  }

  return async function handle(request: AppRequest): Promise<AppResponse> {
    try {
      if (deps.appKey && request.path === "/gorgias/events") {
        const key = request.query["key"] ?? "";
        if (key !== deps.appKey) return json(401, { error: "bad key" });
      }

      if (request.path === "/gorgias/events" && request.method === "POST") {
        const ticketId = ticketIdFrom(request);
        if (!ticketId) return json(400, { error: "no ticket id" });
        const view = await load(ticketId);
        return json(200, view.data);
      }

      if (request.path === "/gorgias/widget" && request.method === "GET") {
        const ticketId = ticketIdFrom(request);
        if (!ticketId) return json(400, { error: "no ticket id" });
        const view = await load(ticketId);
        return json(200, view.data);
      }

      if (request.path === "/gorgias/reason" && request.method === "GET") {
        const ticketId = ticketIdFrom(request);
        if (!ticketId) return json(400, { error: "no ticket id" });
        const code = request.query["code"] ?? "";
        const note = request.query["note"] ?? "";
        const state = store.get(ticketId);
        if (code) {
          return html(200, reasonPage(await complete(state, code, note)));
        }
        return html(200, reasonForm(ticketId, quickReasons(deps.settings), note));
      }

      if (request.path === "/gorgias/reason" && request.method === "POST") {
        const ticketId = ticketIdFrom(request);
        if (!ticketId) return json(400, { error: "no ticket id" });
        const body = (request.body ?? {}) as Record<string, unknown>;
        const code = typeof body["code"] === "string" ? body["code"] : "";
        const note = typeof body["note"] === "string" ? body["note"] : "";
        if (!code) return json(400, { error: "no reason code" });
        return html(200, reasonPage(await complete(store.get(ticketId), code, note)));
      }

      return json(404, { error: "not found" });
    } catch (error) {
      // Nothing here may break a ticket: answer with a card that says nothing happened.
      return json(200, {
        status: "Waiting for a draft",
        ticket_id: ticketIdFrom(request) ?? "",
        order: null,
        note: null,
        reasons: [],
        notes: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export interface ServerOptions extends AppDeps {
  port?: number;
}

/** The Node server the deployment runs. */
export function createNodeServer(options: ServerOptions) {
  const app = createApp(options);
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void handle(request, response, app);
  });
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  app: (request: AppRequest) => Promise<AppResponse>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  let body: unknown = null;
  if (request.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
      }
    }
  }
  const result = await app({ method: request.method ?? "GET", path: url.pathname, query, body });
  response.writeHead(result.status, { "Content-Type": result.contentType });
  response.end(result.body);
}
