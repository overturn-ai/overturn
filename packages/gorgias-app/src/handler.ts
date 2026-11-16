import type { CaptureCreate } from "@overturn-ai/shared";
import {
  type AppSettings,
  type DraftOrigin,
  type DraftState,
  decideOnSend,
  draftFromHand,
  draftFromRun,
  inScope,
  type RecordedRun,
  type TicketSnapshot,
} from "./capture";
import { tokenQuery, type WidgetData, widgetData } from "./widget";

/** The part of the capture response the sidebar repeats. */
export interface CaptureOutcome {
  kind: "edit" | "approve";
  changed: boolean;
  deduplicated: boolean;
  /** The case this made, when it made one. */
  case: { title: string } | null;
}

/** The Overturn API, as this app uses it. */
export interface OverturnPort {
  /** The latest run the drafting agent recorded for this thread, if any. */
  lastRun(externalId: string, agent: string): Promise<RecordedRun | null>;
  capture(body: CaptureCreate): Promise<CaptureOutcome>;
}

/** The Gorgias REST API, as this app uses it. */
export interface GorgiasPort {
  ticket(id: string): Promise<TicketSnapshot>;
}

/** Everything the app remembers about one ticket between Gorgias' triggers. */
export interface TicketState {
  draft: DraftState | null;
  /** The decision fields as they stood when the draft was last seen, for an exact field diff. */
  draftFields: Record<string, unknown>;
  /** The reason on file for this ticket, picked one click at a time. */
  reason: { code: string; note: string; at: number } | null;
  /** The newest reply the app has already accounted for, so nothing is filed twice. */
  seenReplyId: string | number | null;
  lastResult: { kind: string; changed: boolean; deduplicated: boolean } | null;
  /** A changed reply kept until a reason is picked (`require_reason`), the send having gone out. */
  pending: { body: CaptureCreate; replyId: string | number | null; changedFields: string[] } | null;
  /** Why the last attempt failed, said plainly in the widget. */
  note: string | null;
}

export const EMPTY_STATE: TicketState = {
  draft: null,
  draftFields: {},
  reason: null,
  seenReplyId: null,
  lastResult: null,
  pending: null,
  note: null,
};

function emptyState(): TicketState {
  return { ...EMPTY_STATE, draftFields: {} };
}

export interface CaptureStore {
  get(ticketId: string): Promise<TicketState>;
  set(ticketId: string, state: TicketState): Promise<void>;
}

/** One process, one Gorgias helpdesk: enough for the first installs, and the seam for a real one. */
export function createMemoryStore(): CaptureStore {
  const tickets = new Map<string, TicketState>();
  return {
    async get(ticketId) {
      const found = tickets.get(ticketId);
      return found ? { ...found } : emptyState();
    },
    async set(ticketId, state) {
      tickets.set(ticketId, { ...state });
    },
  };
}

export interface HandlerDeps {
  settings: AppSettings;
  gorgias: GorgiasPort;
  overturn: OverturnPort;
  store?: CaptureStore;
  now?: () => number;
}

export type Handler = (req: Request) => Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{margin:0;padding:24px;font:14px/1.5 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2328;}
h1{font-size:16px;margin:0 0 8px;}p{margin:0 0 12px;color:#57606a;}
textarea{width:100%;box-sizing:border-box;min-height:160px;border:1px solid #d0d7de;border-radius:6px;padding:8px;font:inherit;}
button{margin-top:10px;border:0;border-radius:6px;padding:8px 14px;background:#1f6feb;color:#fff;font:inherit;cursor:pointer;}
.chip{display:inline-block;margin:0 8px 8px 0;padding:2px 10px;border-radius:999px;background:#ddf4ff;color:#0969da;}
.ok{color:#1a7f37;font-weight:600;}
</style></head><body>${body}</body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function message(e: unknown): string {
  if (e && typeof e === "object" && "status" in e && typeof (e as { status?: unknown }).status === "number") {
    return `HTTP ${(e as { status: number }).status}`;
  }
  return e instanceof Error ? e.message : "network error";
}

/** The newest message an agent sent on the ticket: the reply the draft was for. */
function newestAgentReply(ticket: TicketSnapshot) {
  return ticket.messages.filter((m) => m.fromAgent).at(-1) ?? null;
}

function replyTime(m: { createdAt?: string | null }): number {
  const t = m.createdAt ? Date.parse(m.createdAt) : Number.NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** What the widget's Detail row says, in order of what the agent needs to know. */
function detailLine(state: TicketState): string | null {
  if (state.note) return state.note;
  if (state.pending) {
    const why = state.pending.changedFields.length > 0 ? state.pending.changedFields.join(", ") : "the reply";
    return `Sent and not filed yet: pick why you changed ${why} (one click below).`;
  }
  if (state.lastResult?.changed && state.lastResult.kind === "edit") {
    return "Filed as a case. Overturn replays it before the next model change.";
  }
  if (state.draft && !state.reason) return "Changed the draft? Pick why below (one click) before you send.";
  return null;
}

/**
 * The app Gorgias calls. Nothing here touches the send: a capture is filed after the reply is in
 * the thread, and a reason the app is still waiting for holds the capture, never the agent's work.
 */
export function createHandler(deps: HandlerDeps): Handler {
  const settings = deps.settings;
  const store = deps.store ?? createMemoryStore();
  const now = deps.now ?? (() => Date.now());

  const authorized = (token: string | null): boolean =>
    !settings.widgetToken || token === settings.widgetToken;

  async function sync(ticketId: string): Promise<TicketState> {
    const state = await store.get(ticketId);
    let ticket: TicketSnapshot;
    try {
      ticket = await deps.gorgias.ticket(ticketId);
    } catch (e) {
      state.note = `Could not read this ticket (${message(e)}).`;
      await store.set(ticketId, state);
      return state;
    }
    // With a scope tag, a ticket without it is never read further: not the runs, not the thread.
    if (!inScope(ticket.tags, settings)) {
      state.note = `Not watching: no "${settings.scopeTag}" tag.`;
      await store.set(ticketId, state);
      return state;
    }
    if (!state.draft) {
      try {
        const run = await deps.overturn.lastRun(`gr:${ticketId}`, settings.agent);
        const recorded = run ? draftFromRun(run, now()) : null;
        if (recorded) state.draft = recorded;
      } catch {
        // no recorded draft; the agent can offer the text by hand from the widget
      }
    }
    const reply = newestAgentReply(ticket);

    if (state.pending && state.reason) {
      const held = state.pending;
      const filed = await file(state, {
        ...held.body,
        reason: state.reason.note || null,
        reasonCode: state.reason.code,
      });
      if (filed) {
        state.pending = null;
        state.seenReplyId = held.replyId ?? state.seenReplyId;
      }
      await store.set(ticketId, state);
      return state;
    }

    const fresh =
      reply !== null &&
      state.draft !== null &&
      reply.id !== undefined &&
      String(reply.id) !== String(state.seenReplyId) &&
      replyTime(reply) >= state.draft.at;
    if (reply && state.draft && fresh) {
      const decision = decideOnSend({
        ticket,
        draft: state.draft,
        draftFields: state.draftFields,
        send: { text: reply.text, public: reply.public, fields: ticket.fields, messageId: reply.id ?? null },
        reasonCode: state.reason?.code ?? null,
        reason: state.reason?.note ?? "",
        actor: reply.senderEmail ?? null,
        settings,
        now: now(),
      });
      if (decision.action === "skip") {
        state.note = null;
        state.seenReplyId = reply.id ?? null;
      } else if (decision.action === "need-reason") {
        state.note = null;
        state.pending = {
          body: decision.body,
          replyId: reply.id ?? null,
          changedFields: decision.changedFields,
        };
      } else if (await file(state, decision.body)) {
        state.seenReplyId = reply.id ?? null;
      }
    } else if (state.draft) {
      // The fields as they stand while the draft is in front of the agent: the diff at send time
      // is against these, not against what the send itself changed.
      state.draftFields = ticket.fields;
    }
    await store.set(ticketId, state);
    return state;
  }

  /** Post the capture, and never let a failure reach the agent as a lost reply. */
  async function file(state: TicketState, body: CaptureCreate): Promise<boolean> {
    try {
      const result = await deps.overturn.capture(body);
      state.lastResult = { kind: result.kind, changed: result.changed, deduplicated: result.deduplicated };
      state.note = null;
      state.draft = null;
      state.draftFields = {};
      state.reason = null;
      return true;
    } catch (e) {
      state.note = `Overturn could not save this correction (${message(e)}). It will be retried.`;
      return false;
    }
  }

  async function widget(url: URL): Promise<Response> {
    const ticketId = url.searchParams.get("ticket_id");
    if (!ticketId) return json({ error: "ticket_id is required" }, 400);
    const state = await sync(ticketId);
    const data: WidgetData = widgetData({
      settings,
      ticketId,
      draft: state.draft,
      lastResult: state.lastResult,
      detail: detailLine(state),
      reasonCode: state.reason?.code ?? null,
    });
    return json(data);
  }

  async function pickReason(ticketId: string, code: string, note: string): Promise<Response> {
    const state = await store.get(ticketId);
    state.reason = { code, note, at: now() };
    state.note = null;
    const held = state.pending;
    if (held) {
      if (await file(state, { ...held.body, reason: note || null, reasonCode: code })) {
        state.pending = null;
        state.seenReplyId = held.replyId ?? state.seenReplyId;
      } else {
        // The body is kept: the next trigger, or this page again, files it with the reason on file.
        state.pending = held;
      }
    }
    await store.set(ticketId, state);
    const back = `${settings.appUrl}/gorgias/draft?ticket_id=${encodeURIComponent(ticketId)}${tokenQuery(settings)}`;
    const title = state.note ? `<h1>${escapeHtml(state.note)}</h1>` : `<h1 class="ok">Reason recorded</h1>`;
    const body = `${title}
<p>Ticket ${escapeHtml(ticketId)} · <span class="chip">${escapeHtml(code)}</span></p>
<form method="post" action="/gorgias/reason" enctype="application/x-www-form-urlencoded">
<input type="hidden" name="ticket_id" value="${escapeHtml(ticketId)}">
<input type="hidden" name="code" value="${escapeHtml(code)}">
<input type="hidden" name="token" value="${escapeHtml(settings.widgetToken ?? "")}">
<textarea id="note" name="note" placeholder="Anything else? Optional.">${escapeHtml(note)}</textarea>
<button type="submit">Save the note</button>
</form>
<p style="margin-top:12px"><a href="${escapeHtml(back)}">Put the draft text in Overturn</a> · you can close this tab.</p>`;
    return page("Overturn · reason", body);
  }

  function draftPage(ticketId: string, error: string | null): Response {
    const body = `<h1>Put the draft text in Overturn</h1>
${error ? `<p>${escapeHtml(error)}</p>` : ""}
<p>For ticket ${escapeHtml(ticketId)}. Paste what the AI put in the reply box (or what you wrote), and
Overturn diffs it against what you send, exactly as it does for a drafting agent that recorded its run.
At least ${settings.minDraftChars} characters.</p>
<form method="post" action="/gorgias/draft" enctype="application/x-www-form-urlencoded">
<input type="hidden" name="ticket_id" value="${escapeHtml(ticketId)}">
<input type="hidden" name="token" value="${escapeHtml(settings.widgetToken ?? "")}">
<textarea id="text" name="text" placeholder="The draft as it is in the reply box"></textarea>
<button type="submit">Use this text as the draft</button>
</form>
<p style="margin-top:12px"><a href="${escapeHtml(settings.appUrl)}">Overturn</a></p>`;
    return page("Overturn · draft", body);
  }

  return async function handler(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, agent: settings.agent });
    if (!url.pathname.startsWith("/gorgias/")) return json({ error: "not found" }, 404);

    try {
      // The integration URL is a GET with the token in the query; the pages post it back in the body.
      const form = req.method === "POST" ? new URLSearchParams(await req.text()) : null;
      const token = form?.get("token") ?? url.searchParams.get("token");
      if (!authorized(token)) return json({ error: "bad token" }, 403);

      if (url.pathname === "/gorgias/widget") return await widget(url);

      if (url.pathname === "/gorgias/reason") {
        const ticketId = form?.get("ticket_id") ?? url.searchParams.get("ticket_id");
        const code = (form?.get("code") ?? url.searchParams.get("code") ?? "").trim();
        const note = (form?.get("note") ?? url.searchParams.get("note") ?? "").trim();
        if (!ticketId) return json({ error: "ticket_id is required" }, 400);
        if (!/^[a-z0-9_]{1,64}$/i.test(code)) return json({ error: "code is required" }, 400);
        return await pickReason(ticketId, code, note);
      }

      if (url.pathname === "/gorgias/draft") {
        const ticketId = form?.get("ticket_id") ?? url.searchParams.get("ticket_id") ?? "";
        if (!ticketId) return json({ error: "ticket_id is required" }, 400);
        if (!form) return draftPage(ticketId, null);
        const origin: DraftOrigin = form.get("origin") === "inserted" ? "inserted" : "manual";
        const draft = draftFromHand(form.get("text") ?? "", settings, { origin, now: now() });
        if (!draft) {
          return draftPage(
            ticketId,
            `That is shorter than ${settings.minDraftChars} characters, so it is not a draft.`,
          );
        }
        const state = await store.get(ticketId);
        state.draft = draft;
        state.note = null;
        await store.set(ticketId, state);
        const words = draft.text.trim().split(/\s+/).length;
        return page(
          "Overturn · draft",
          `<h1 class="ok">Draft saved · ${words} words</h1><p>Ticket ${escapeHtml(ticketId)}. Send the reply as you would; the edit is filed with the reason you pick.</p>`,
        );
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      // A broken app is never a broken helpdesk: say what happened, return something usable.
      return json({ error: message(e) }, 500);
    }
  };
}
