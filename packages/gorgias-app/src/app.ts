import { createHmac, timingSafeEqual } from "node:crypto";
import type { CaptureCreate, CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type DraftState,
  decideOnSend,
  fieldsFrom,
  type GorgiasMessage,
  isNote,
  messageText,
  ordersFrom,
  quickReasons,
  reasonFromTags,
  statusLine,
  stripHtml,
  type TicketSnapshot,
} from "./capture";

/** A Gorgias ticket, as far as this app reads it (`GET /api/tickets/{id}`). */
export interface GorgiasTicket {
  id: number | string;
  subject?: string | null;
  customer?: { email?: string | null; name?: string | null; integrations?: unknown } | null;
  messages?: GorgiasMessage[];
  tags?: Array<{ name?: string }>;
  custom_fields?: unknown;
}

export interface TicketState {
  draft: DraftState | null;
  draftFields: Record<string, unknown>;
  reasonCode: string | null;
  reason: string;
  /** A changed reply that went out before a reason was picked; posted once there is one. */
  held: { body: CaptureCreate; changedFields: string[] } | null;
  lastResult: { changed: boolean; dedup: boolean } | null;
  message: string;
  /** Agent messages already captured, so a later event does not capture them twice. */
  captured: string[];
}

export interface Store {
  get(id: string): Promise<TicketState | undefined>;
  set(id: string, s: TicketState): Promise<void>;
}

export function memoryStore(): Store {
  const m = new Map<string, TicketState>();
  return {
    get: async (id) => m.get(id),
    set: async (id, s) => {
      m.set(id, s);
    },
  };
}

export interface Overturn {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface Deps {
  settings: AppSettings;
  store: Store;
  overturn: Overturn;
  /** Reads a ticket through the Gorgias REST API. Called only once the ticket has a draft. */
  fetchTicket: (id: string) => Promise<GorgiasTicket>;
  /** Shared secret: the `X-Overturn-Token` header on the HTTP integration, and the key that signs reason links. */
  token: string;
  /** This app's public URL, for the reason links in the widget. */
  publicUrl: string;
  /** `https://<account>.gorgias.com`, for the link back from the run page. */
  gorgiasUrl?: string | null;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface HttpRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: string;
}
export interface HttpResponse {
  status: number;
  body: unknown;
  contentType?: string;
}

const fresh = (): TicketState => ({
  draft: null,
  draftFields: {},
  reasonCode: null,
  reason: "",
  held: null,
  lastResult: null,
  message: "",
  captured: [],
});

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function reasonSig(token: string, ticketId: string, code: string): string {
  return createHmac("sha256", token).update(`${ticketId}:${code}`).digest("hex").slice(0, 32);
}

export function snapshotFrom(
  t: GorgiasTicket,
  settings: AppSettings,
  gorgiasUrl?: string | null,
): TicketSnapshot {
  const messages = [...(t.messages ?? [])].sort((a, b) =>
    (a.created_datetime ?? "").localeCompare(b.created_datetime ?? ""),
  );
  return {
    id: t.id,
    subject: t.subject ?? null,
    customerEmail: t.customer?.email ?? null,
    customerName: t.customer?.name ?? null,
    messages,
    orders: ordersFrom(t.customer?.integrations, settings.maxOrders),
    fields: fieldsFrom(t.custom_fields, settings),
    url: gorgiasUrl ? `${gorgiasUrl.replace(/\/+$/, "")}/app/ticket/${t.id}` : null,
  };
}

/** The JSON the ticket sidebar widget renders (the HTTP integration's response). */
export interface WidgetData {
  overturn: {
    status: string;
    message: string | null;
    reasons: Array<{ label: string; url: string }>;
  };
}

export function createApp(deps: Deps): (req: HttpRequest) => Promise<HttpResponse> {
  const { settings, store, overturn } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const base = deps.publicUrl.replace(/\/+$/, "");
  const load = async (id: string): Promise<TicketState> => (await store.get(id)) ?? fresh();

  const widget = (id: string, s: TicketState): WidgetData => ({
    overturn: {
      status: s.held
        ? `Pick why you changed the ${s.held.changedFields.length ? s.held.changedFields.join(", ") : "reply"}`
        : statusLine(s.draft, s.lastResult),
      message: s.message || null,
      reasons:
        s.draft || s.held
          ? quickReasons(settings).map((r) => ({
              label: s.reasonCode === r.code ? `✓ ${r.label}` : r.label,
              url: `${base}/reason?ticket=${encodeURIComponent(id)}&code=${r.code}&sig=${reasonSig(deps.token, id, r.code)}`,
            }))
          : [],
    },
  });

  const lookupRecorded = async (id: string, s: TicketState): Promise<void> => {
    try {
      const found = await overturn.get<{
        items: Array<{ id: string; output: unknown; model?: string | null; startedAt?: string }>;
      }>(
        `/v1/runs?externalId=${encodeURIComponent(`gr:${id}`)}&agent=${encodeURIComponent(settings.agent)}&limit=1`,
      );
      const run = found.items[0];
      if (run && typeof run.output === "string" && run.output.trim()) {
        const started = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
        s.draft = {
          text: run.output,
          origin: "recorded",
          runId: run.id,
          model: run.model ?? null,
          at: Number.isFinite(started) ? started : now(),
        };
      }
    } catch {
      // no recorded draft yet
    }
  };

  const post = async (id: string, s: TicketState, body: CaptureCreate): Promise<void> => {
    try {
      const r = await overturn.post<CaptureResult>("/v1/capture", body);
      s.lastResult = { changed: r.changed, dedup: r.deduplicated };
      s.message = r.changed && r.case ? `Case: ${r.case.title}` : "";
      s.draft = null;
      s.reasonCode = null;
      s.reason = "";
    } catch (e) {
      // The reply already went out; never in the agent's way. Say so in the widget.
      const status = (e as { status?: number }).status;
      log(`capture failed for gr:${id}: ${status ?? "network"}`);
      s.message = `Overturn could not save this correction (${status ?? "network"}).`;
    }
    s.held = null;
    await store.set(id, s);
  };

  /** Any ticket event: arm the draft, pick up a tag reason, and capture a reply that went out. */
  const onEvent = async (id: string): Promise<HttpResponse> => {
    const s = await load(id);
    if (!s.draft && !s.held) await lookupRecorded(id, s);
    // A ticket with no draft is never read.
    if (!s.draft && !s.held) {
      await store.set(id, s);
      return { status: 200, body: widget(id, s) };
    }
    const ticket = await deps.fetchTicket(id);
    const snap = snapshotFrom(ticket, settings, deps.gorgiasUrl);
    const tagged = reasonFromTags(ticket.tags ?? [], settings);
    if (tagged) s.reasonCode = tagged;
    if (s.held) {
      if (s.reasonCode)
        await post(id, s, { ...s.held.body, reasonCode: s.reasonCode, reason: s.reason.trim() || null });
      else await store.set(id, s);
      return { status: 200, body: widget(id, s) };
    }
    const draft = s.draft!;
    if (!Object.keys(s.draftFields).length) s.draftFields = snap.fields;
    // The reply: the newest agent message sent after the draft appeared and not captured yet.
    const sent = [...snap.messages]
      .reverse()
      .find(
        (m) =>
          m.from_agent &&
          !s.captured.includes(String(m.id)) &&
          (!m.created_datetime || Date.parse(m.created_datetime) >= draft.at - 1000) &&
          messageText(m),
      );
    if (!sent) {
      await store.set(id, s);
      return { status: 200, body: widget(id, s) };
    }
    s.captured = [...s.captured, String(sent.id)].slice(-50);
    const context = { ...snap, messages: snap.messages.filter((m) => m !== sent) };
    const args = {
      ticket: context,
      draft,
      draftFields: s.draftFields,
      send: {
        text: messageText(sent),
        type: isNote(sent) ? ("note" as const) : ("reply" as const),
        fields: snap.fields,
      },
      reasonCode: s.reasonCode,
      reason: s.reason,
      actor: sent.sender?.email ?? sent.sender?.name ?? null,
      settings,
      now: sent.created_datetime ? Date.parse(sent.created_datetime) : now(),
    };
    const decision = decideOnSend(args);
    if (decision.action === "skip") {
      await store.set(id, s);
      return { status: 200, body: widget(id, s) };
    }
    if (decision.action === "need-reason") {
      const open = decideOnSend({ ...args, settings: { ...settings, requireReason: false } });
      if (open.action === "capture") s.held = { body: open.body, changedFields: decision.changedFields };
      await store.set(id, s);
      return { status: 200, body: widget(id, s) };
    }
    await post(id, s, decision.body);
    return { status: 200, body: widget(id, s) };
  };

  /** The drafting tool hands over the draft as it puts it in the reply box. */
  const onDraft = async (body: {
    ticket_id?: unknown;
    text?: unknown;
    model?: unknown;
  }): Promise<HttpResponse> => {
    const id = body.ticket_id == null ? "" : String(body.ticket_id);
    const text = typeof body.text === "string" ? body.text : "";
    if (!id) return { status: 400, body: { error: "ticket_id is required" } };
    if (stripHtml(text).length < settings.minDraftChars)
      return { status: 422, body: { error: `a draft is at least ${settings.minDraftChars} characters` } };
    const s = await load(id);
    s.draft = {
      text,
      origin: "inserted",
      model: typeof body.model === "string" ? body.model : null,
      at: now(),
    };
    s.draftFields = {};
    s.lastResult = null;
    s.message = "";
    await store.set(id, s);
    return { status: 200, body: widget(id, s) };
  };

  const page = (text: string, status = 200): HttpResponse => ({
    status,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html><meta charset="utf-8"><title>Overturn</title><body style="font:14px system-ui;padding:24px">${text.replace(/[<>&]/g, "")}</body>`,
  });

  /** A reason link from the widget. */
  const onReason = async (q: HttpRequest["query"]): Promise<HttpResponse> => {
    const id = q.ticket ?? "";
    const code = q.code ?? "";
    if (!id || !code || !q.sig || !safeEqual(reasonSig(deps.token, id, code), q.sig))
      return page("This link is not valid.", 403);
    if (!quickReasons(settings).some((r) => r.code === code)) return page("Unknown reason.", 400);
    const s = await load(id);
    s.reasonCode = code;
    if (q.note) s.reason = q.note;
    if (s.held) {
      await post(id, s, { ...s.held.body, reasonCode: code, reason: s.reason.trim() || null });
      return page(s.message.startsWith("Overturn could not") ? s.message : "Saved. You can close this tab.");
    }
    await store.set(id, s);
    return page("Reason saved. It goes with the reply when you send it.");
  };

  return async (req) => {
    try {
      if (req.method === "GET" && req.path === "/reason") return await onReason(req.query);
      if (req.method !== "POST") return { status: 405, body: { error: "method not allowed" } };
      const token = req.headers["x-overturn-token"] ?? req.query.token ?? "";
      if (!safeEqual(token, deps.token)) return { status: 401, body: { error: "bad token" } };
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(req.body || "{}") as Record<string, unknown>;
      } catch {
        return { status: 400, body: { error: "invalid json" } };
      }
      if (req.path === "/events") {
        const id = body.ticket_id == null ? "" : String(body.ticket_id);
        if (!id) return { status: 400, body: { error: "ticket_id is required" } };
        return await onEvent(id);
      }
      if (req.path === "/draft") return await onDraft(body);
      return { status: 404, body: { error: "not found" } };
    } catch (e) {
      // Gorgias retries failed integrations; acknowledge and keep out of the way.
      log(`handler error: ${(e as Error).message}`);
      return {
        status: 200,
        body: { overturn: { status: "Overturn is unavailable", message: null, reasons: [] } },
      };
    }
  };
}
