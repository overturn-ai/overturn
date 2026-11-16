import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  decideOnSend,
  draftFromRun,
  externalIdFor,
  type GorgiasMessage,
  type GorgiasTicket,
  inScope,
  latestExchange,
  type RecordedRun,
  type SendDecision,
  settingsFrom,
  statusLine,
} from "./capture";

/**
 * The Gorgias glue, as one fetch handler (Request → Response) that runs on any runtime with
 * web fetch: Node 22 (`server.ts`), Cloudflare Workers, Deno, Bun.
 *
 *  - `POST /gorgias/event?ticket_id={{ticket.id}}` is the HTTP integration Gorgias calls on
 *    "ticket message created". Its JSON answer is what the Overturn sidebar widget shows.
 *  - `POST /gorgias/reason` is the widget's reason buttons (one per code, with a note field).
 *
 * Gorgias has already sent the reply when either call arrives, so nothing here can delay or
 * block a send; every failure (Gorgias, Overturn, bad input) still answers 200 with a status
 * line, so the widget says what happened and Gorgias never retries into a duplicate.
 */

export interface HandlerEnv {
  /** Project API key from Overturn (Settings → API keys). */
  OVERTURN_API_KEY: string;
  /** Shared secret Gorgias sends as `X-Overturn-Secret` on the integration and the buttons. */
  WEBHOOK_SECRET: string;
  /** `acme` for acme.gorgias.com. */
  GORGIAS_DOMAIN: string;
  /** The Gorgias user (email) and REST API key the handler reads tickets with. */
  GORGIAS_USER: string;
  GORGIAS_API_KEY: string;
  OVERTURN_BASE_URL?: string;
  AGENT?: string;
  REQUIRE_REASON?: string;
  REASON_PACK?: string;
  SCOPE_TAG?: string;
  MIN_DRAFT_CHARS?: string;
  DRAFT_MARKER?: string;
  DRAFT_AUTHORS?: string;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What the sidebar widget renders (the widget template reads `overturn.*`). */
export interface WidgetData {
  overturn: {
    ticket_id: string | null;
    status: string;
    draft_words: number | null;
    /** A changed reply waiting for its reason; the capture posts when one is clicked. */
    pending_reason: boolean;
    case_title: string | null;
  };
}

export function settingsFromEnv(env: HandlerEnv): AppSettings {
  return settingsFrom({
    overturn_base_url: env.OVERTURN_BASE_URL,
    agent: env.AGENT,
    require_reason: env.REQUIRE_REASON,
    reason_pack: env.REASON_PACK,
    scope_tag: env.SCOPE_TAG,
    min_draft_chars: env.MIN_DRAFT_CHARS,
    draft_marker: env.DRAFT_MARKER,
    draft_authors: env.DRAFT_AUTHORS,
    gorgias_domain: env.GORGIAS_DOMAIN,
  });
}

/** Length-independent comparison, so the secret cannot be guessed byte by byte from timings. */
export function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const base64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export function createGorgiasClient(env: HandlerEnv, fetchImpl: Fetch) {
  const root = `https://${env.GORGIAS_DOMAIN}.gorgias.com/api`;
  const auth = `Basic ${base64(`${env.GORGIAS_USER}:${env.GORGIAS_API_KEY}`)}`;
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`${root}${path}`, {
      headers: { authorization: auth, accept: "application/json" },
    });
    if (!res.ok) throw new HttpError(res.status, `gorgias ${path}`);
    return (await res.json()) as T;
  };
  return {
    /** The ticket with its messages (`GET /api/tickets/{id}`; messages listed separately if absent). */
    async ticket(id: string): Promise<GorgiasTicket> {
      const t = await get<GorgiasTicket>(`/tickets/${encodeURIComponent(id)}`);
      if (!Array.isArray(t.messages)) {
        const list = await get<{ data?: GorgiasMessage[] }>(`/tickets/${encodeURIComponent(id)}/messages`);
        t.messages = list.data ?? [];
      }
      return t;
    },
  };
}

export function createOverturnClient(env: HandlerEnv, settings: AppSettings, fetchImpl: Fetch) {
  const headers = { authorization: `Bearer ${env.OVERTURN_API_KEY}`, accept: "application/json" };
  return {
    /** The drafting agent's run on this ticket, if it recorded one with the SDK. */
    async recordedRun(ticketId: string): Promise<RecordedRun | null> {
      const q = new URLSearchParams({
        externalId: externalIdFor(ticketId),
        agent: settings.agent,
        limit: "1",
      });
      const res = await fetchImpl(`${settings.baseUrl}/v1/runs?${q}`, { headers });
      if (!res.ok) return null;
      const body = (await res.json()) as { items?: RecordedRun[] };
      return body.items?.[0] ?? null;
    },
    async capture(body: unknown): Promise<CaptureResult> {
      const res = await fetchImpl(`${settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new HttpError(res.status, "overturn capture");
      return (await res.json()) as CaptureResult;
    },
  };
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

const widget = (
  ticketId: string | null,
  status: string,
  extra: Partial<WidgetData["overturn"]> = {},
): Response =>
  json({
    overturn: {
      ticket_id: ticketId,
      status,
      draft_words: null,
      pending_reason: false,
      case_title: null,
      ...extra,
    },
  } satisfies WidgetData);

async function readParams(req: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) out[k] = v;
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await req.json()) as Record<string, unknown>;
      for (const [k, v] of Object.entries(body ?? {})) if (v != null) out[k] = String(v);
    } else if (type.includes("application/x-www-form-urlencoded")) {
      for (const [k, v] of new URLSearchParams(await req.text())) out[k] = v;
    }
  } catch {
    // an unreadable body is treated as no body; the ticket id is required below
  }
  return out;
}

export function createHandler(
  env: HandlerEnv,
  fetchImpl: Fetch = fetch,
): (req: Request) => Promise<Response> {
  const settings = settingsFromEnv(env);
  const gorgias = createGorgiasClient(env, fetchImpl);
  const overturn = createOverturnClient(env, settings, fetchImpl);

  const post = async (
    ticketId: string,
    decision: SendDecision & { action: "capture" },
  ): Promise<Response> => {
    try {
      const r = await overturn.capture(decision.body);
      return widget(ticketId, statusLine({ kind: "captured", changed: r.changed, dedup: r.deduplicated }), {
        case_title: r.changed && r.case ? r.case.title : null,
      });
    } catch (e) {
      return widget(
        ticketId,
        statusLine({ kind: "error", status: e instanceof HttpError ? e.status : "network" }),
      );
    }
  };

  const load = async (ticketId: string) => {
    const ticket = await gorgias.ticket(ticketId);
    // Out of scope: nothing beyond the ticket's tags is looked at, and nothing leaves Gorgias.
    if (!inScope(ticket, settings)) return { ticket, exchange: null };
    const recorded = draftFromRun(await overturn.recordedRun(ticketId).catch(() => null));
    return { ticket, exchange: latestExchange(ticket, settings, recorded) };
  };

  return async (req) => {
    const path = new URL(req.url).pathname.replace(/\/+$/, "");
    if (req.method === "GET" && path === "/health") return json({ ok: true });
    if (req.method !== "POST" && req.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (!env.WEBHOOK_SECRET || !safeEqual(req.headers.get("x-overturn-secret") ?? "", env.WEBHOOK_SECRET)) {
      return json({ error: "unauthorized" }, 401);
    }
    const params = await readParams(req);
    const ticketId = params.ticket_id?.trim() || null;
    if (!ticketId || !/^\d+$/.test(ticketId)) return widget(null, "No ticket id in the request");

    let loaded: Awaited<ReturnType<typeof load>>;
    try {
      loaded = await load(ticketId);
    } catch (e) {
      return widget(
        ticketId,
        `Overturn could not read this ticket (${e instanceof HttpError ? e.status : "network"})`,
      );
    }
    const { ticket, exchange } = loaded;
    if (!exchange) return widget(ticketId, `Not watching: no "${settings.scopeTag}" tag`);

    if (path === "/gorgias/event") {
      if (!exchange.draft) return widget(ticketId, statusLine({ kind: "waiting" }));
      const words = { draft_words: exchange.draft.text.trim().split(/\s+/).length };
      // The send that woke us is the newest message; any later event (a customer reply, a
      // note) re-reads an exchange that was already captured, so it only refreshes the panel.
      if (!exchange.sent || !exchange.sentIsLatest) {
        return widget(ticketId, statusLine({ kind: "draft", draft: exchange.draft }), words);
      }
      const decision = decideOnSend({ ticket, exchange, reasonCode: null, reason: "", settings });
      if (decision.action === "need-reason") {
        return widget(ticketId, statusLine({ kind: "need-reason" }), { ...words, pending_reason: true });
      }
      if (decision.action !== "capture")
        return widget(ticketId, statusLine({ kind: "draft", draft: exchange.draft }));
      return post(ticketId, decision);
    }

    if (path === "/gorgias/reason") {
      const reasonCode = params.reason_code?.trim() || null;
      if (!reasonCode || !/^[a-z][a-z0-9_]*$/.test(reasonCode)) return widget(ticketId, "Pick a reason");
      const decision = decideOnSend({
        ticket,
        exchange,
        reasonCode,
        reason: params.note ?? "",
        actor: params.actor?.trim() || null,
        settings,
      });
      if (decision.action === "skip") {
        return widget(
          ticketId,
          decision.why === "not-sent" ? "Nothing sent yet" : statusLine({ kind: "waiting" }),
        );
      }
      if (decision.action === "need-reason") return widget(ticketId, statusLine({ kind: "need-reason" }));
      if (!decision.changed) return widget(ticketId, "Sent as drafted · nothing to fix");
      return post(ticketId, decision);
    }

    return json({ error: "not found" }, 404);
  };
}
