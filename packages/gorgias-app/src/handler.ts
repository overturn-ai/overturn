import type { CaptureCreate } from "@overturn-ai/shared";
import {
  type AppSettings,
  type DraftOrigin,
  type DraftState,
  decideOnSend,
  discardRun,
  draftFromHand,
  draftFromRun,
  inScope,
  isInternalNote,
  isSentReply,
  type MessageSnapshot,
  type RecordedRun,
  type TicketSnapshot,
} from "./capture";
import { verifyLink } from "./sign";
import { absolute, linkSigner, type WidgetData, widgetData } from "./widget";

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
  /** Fields, tags, subject and customer: the small read, for freezing and for the capture context. */
  ticket(id: string): Promise<TicketSnapshot>;
  /** The newest messages, newest first: the cheap read that says what Gorgias actually sent. */
  messages(id: string): Promise<MessageSnapshot[]>;
}

/** Everything the app remembers about one ticket between Gorgias' triggers. */
export interface TicketState {
  /** The draft in the reply box, with the decision fields frozen as they were when it appeared. */
  draft: DraftState | null;
  /** The reason on file for this ticket, picked one click at a time. */
  reason: { code: string; note: string; at: number } | null;
  /** The newest reply the app has already accounted for, so nothing is filed twice. */
  seenReplyId: string | number | null;
  /** Runs already spent on a reply, so a stale run never becomes the next draft. */
  consumedRunIds: string[];
  lastResult: { kind: string; changed: boolean; deduplicated: boolean } | null;
  /** A changed reply kept until a reason is picked (`require_reason`), the send having gone out. */
  pending: { body: CaptureCreate; replyId: string | number | null; changedFields: string[] } | null;
  /** Why the last attempt failed, said plainly in the widget. */
  note: string | null;
}

export const EMPTY_STATE: TicketState = {
  draft: null,
  reason: null,
  seenReplyId: null,
  consumedRunIds: [],
  lastResult: null,
  pending: null,
  note: null,
};

function emptyState(): TicketState {
  return { ...EMPTY_STATE, consumedRunIds: [] };
}

/** Twenty replies of history is far more than a diff ever needs. */
const MAX_CONSUMED_RUNS = 20;

export interface CaptureStore {
  get(ticketId: string): Promise<TicketState>;
  set(ticketId: string, state: TicketState): Promise<void>;
}

/** For tests and demos. `main.ts` wires the file store, so a restart is not a reset. */
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
.ok{color:#1a7f37;font-weight:600;}fieldset{border:0;padding:0;margin:0 0 10px;}label{margin-right:14px;}
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

/** The newest reply Gorgias actually sent. An outbound message still being created is not one. */
function newestSentReply(messages: MessageSnapshot[]): MessageSnapshot | null {
  return messages.filter((m) => isSentReply(m)).at(-1) ?? null;
}

function sentTime(m: MessageSnapshot): number {
  const iso = m.sentAt ?? m.createdAt;
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** What the widget's Detail row says, in order of what the agent needs to know. */
function detailLine(state: TicketState): string | null {
  if (state.note) return state.note;
  if (state.pending) {
    const why = state.pending.changedFields.join(", ") || "the reply";
    return `Sent and not filed yet: pick why you changed ${why} (one click below).`;
  }
  if (state.lastResult?.changed && state.lastResult.kind === "edit") {
    return "Filed as a case. Overturn replays it before the next model change.";
  }
  if (state.draft) return "Changed the draft? Pick why below (one click) before you send.";
  return null;
}

/**
 * The app Gorgias calls. Nothing here touches the send: a capture is filed once Gorgias reports the
 * reply as sent, and a reason the app is still waiting for holds the capture, never the agent's work.
 */
export function createHandler(deps: HandlerDeps): Handler {
  const settings = deps.settings;
  const store = deps.store ?? createMemoryStore();
  const now = deps.now ?? (() => Date.now());
  const signer = linkSigner(settings.widgetToken ?? "", now);

  // The shared token is the only authentication a Gorgias integration can carry, so it is compared
  // in constant time. The links an agent sees are signed instead, and never carry the token itself.
  const authorized = (token: string | null): boolean => {
    const expected = settings.widgetToken;
    if (!expected || token === null || token.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
    return diff === 0;
  };

  /** A signed link authorized this request: the action, the ticket and (for a reason) the code. */
  function linkAuthorized(url: URL, action: "reason" | "draft"): boolean {
    const secret = settings.widgetToken;
    const ticketId = url.searchParams.get("ticket_id");
    if (!secret || !ticketId) return false;
    return verifyLink(secret, action, ticketId, url.searchParams.get("exp"), url.searchParams.get("sig"), {
      extra: action === "reason" ? (url.searchParams.get("code") ?? "") : undefined,
      now: now(),
    });
  }

  function rememberRun(state: TicketState, runId: string | undefined): void {
    if (!runId || state.consumedRunIds.includes(runId)) return;
    state.consumedRunIds.push(runId);
    if (state.consumedRunIds.length > MAX_CONSUMED_RUNS) state.consumedRunIds.shift();
  }

  /** Post the capture, and never let a failure reach the agent as a lost reply. */
  async function file(state: TicketState, body: CaptureCreate): Promise<boolean> {
    try {
      const result = await deps.overturn.capture(body);
      state.lastResult = { kind: result.kind, changed: result.changed, deduplicated: result.deduplicated };
      state.note = null;
      rememberRun(state, state.draft?.runId);
      state.draft = null;
      state.reason = null;
      return true;
    } catch (e) {
      state.note = `Overturn could not save this correction (${message(e)}). It will be retried.`;
      return false;
    }
  }

  /** The decision fields as they stand right now, from the small ticket read. */
  async function readFields(ticketId: string): Promise<Record<string, unknown>> {
    if (settings.decisionFields.length === 0) return {};
    return (await deps.gorgias.ticket(ticketId)).fields;
  }

  /**
   * One pass over a ticket: find the draft if there is none, then look for the reply it belongs to.
   * Gorgias is read only when there is something to do with what comes back, and the reply check
   * uses the cheap message list rather than the whole thread.
   */
  async function sync(ticketId: string): Promise<TicketState> {
    const state = await store.get(ticketId);

    // A capture waiting for its reason is filed without reading Gorgias at all.
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

    if (!state.draft) {
      // Cheap first: the agent's own recorded run. No run means no draft, and nothing else is read.
      try {
        const run = await deps.overturn.lastRun(`gr:${ticketId}`, settings.agent);
        if (run && !discardRun(run, state.consumedRunIds)) {
          // The fields are frozen here, when the draft appears, and never re-read after: an agent
          // editing a field while the AI's text sits in the reply box is exactly what the diff is for.
          state.draft = draftFromRun(run, { now: now(), fields: await readFields(ticketId) });
        }
      } catch {
        // no recorded draft; the agent can offer the text by hand from the card
      }
    }

    if (!state.draft) {
      await store.set(ticketId, state);
      return state;
    }

    let ticket: TicketSnapshot;
    let messages: MessageSnapshot[];
    try {
      ticket = await deps.gorgias.ticket(ticketId);
      messages = await repliesFor(ticketId, ticket);
    } catch (e) {
      state.note = `Could not read this ticket (${message(e)}).`;
      await store.set(ticketId, state);
      return state;
    }
    if (!inScope(ticket.tags, settings)) {
      state.note = `Not watching: no "${settings.scopeTag}" tag.`;
      state.draft = null;
      await store.set(ticketId, state);
      return state;
    }

    const reply = newestSentReply(messages);
    const fresh =
      reply !== null &&
      reply.id !== undefined &&
      String(reply.id) !== String(state.seenReplyId) &&
      sentTime(reply) >= state.draft.at;
    if (reply && fresh) {
      if (isInternalNote(reply) && !settings.captureInternalNotes) {
        state.note = null;
        state.seenReplyId = reply.id ?? null;
      } else {
        const decision = decideOnSend({
          ticket,
          draft: state.draft,
          send: {
            text: reply.text,
            public: reply.public,
            fields: ticket.fields,
            messageId: reply.id ?? null,
          },
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
      }
    }
    await store.set(ticketId, state);
    return state;
  }

  /**
   * The messages the send check needs. The flat message list is the cheap read and the one that
   * carries `sent_datetime`; falling back to the ticket body keeps the app working on a helpdesk
   * where that list is not available.
   */
  async function repliesFor(ticketId: string, ticket: TicketSnapshot): Promise<MessageSnapshot[]> {
    try {
      const messages = await deps.gorgias.messages(ticketId);
      return messages.length > 0 ? messages : ticket.messages;
    } catch {
      return ticket.messages;
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

  /** The query a page posts back to: the same signature it was opened with. */
  function signedTail(url: URL): string {
    const exp = url.searchParams.get("exp") ?? "";
    const sig = url.searchParams.get("sig") ?? "";
    return `exp=${encodeURIComponent(exp)}&sig=${encodeURIComponent(sig)}`;
  }

  /** The page a signed reason link opens: it shows what it will record, and posts it. */
  function reasonPage(
    ticketId: string,
    code: string,
    note: string,
    recorded: string | null,
    action: string,
  ): Response {
    const back = absolute(settings.appUrl, signer.draft(ticketId));
    const failed = recorded !== null && !recorded.startsWith("Reason recorded");
    const heading = recorded === null ? "Record this reason?" : escapeHtml(recorded);
    const body = `<h1 class="${recorded === null || failed ? "" : "ok"}">${heading}</h1>
<p>Ticket ${escapeHtml(ticketId)} · <span class="chip">${escapeHtml(code)}</span></p>
<form method="post" action="${escapeHtml(action)}" enctype="application/x-www-form-urlencoded">
<textarea id="note" name="note" placeholder="Anything else? Optional.">${escapeHtml(note)}</textarea>
<button type="submit">${recorded === null ? "Record this reason" : "Save the note"}</button>
</form>
<p style="margin-top:12px"><a href="${escapeHtml(back)}">Put the draft text in Overturn</a> · you can close this tab.</p>`;
    return page("Overturn · reason", body);
  }

  function draftPage(ticketId: string, error: string | null, action: string): Response {
    const body = `<h1>Put the draft text in Overturn</h1>
${error ? `<p>${escapeHtml(error)}</p>` : ""}
<p>For ticket ${escapeHtml(ticketId)}. Paste the text that is in the reply box, and say where it came
from: Overturn diffs it against the reply Gorgias sends, and the source is what the AI-usage numbers
count. At least ${settings.minDraftChars} characters.</p>
<form method="post" action="${escapeHtml(action)}" enctype="application/x-www-form-urlencoded">
<fieldset>
<label><input type="radio" name="source" value="assist" required> The AI wrote it</label>
<label><input type="radio" name="source" value="human"> I wrote it</label>
<label><input type="radio" name="source" value="unknown"> Not sure</label>
</fieldset>
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
      // Gorgias' own call carries the shared token; everything an agent clicks carries a signature.
      const form = req.method === "POST" ? new URLSearchParams(await req.text()) : null;

      if (url.pathname === "/gorgias/widget") {
        if (!authorized(url.searchParams.get("token"))) return json({ error: "bad token" }, 403);
        return await widget(url);
      }

      if (url.pathname === "/gorgias/reason") {
        const ticketId = url.searchParams.get("ticket_id") ?? "";
        const code = (url.searchParams.get("code") ?? "").trim();
        if (!ticketId) return json({ error: "ticket_id is required" }, 400);
        if (!/^[a-z0-9_]{1,64}$/i.test(code)) return json({ error: "code is required" }, 400);
        if (!linkAuthorized(url, "reason")) return json({ error: "link expired or unreadable" }, 403);
        const action = `/gorgias/reason?ticket_id=${encodeURIComponent(ticketId)}&code=${encodeURIComponent(code)}&${signedTail(url)}`;
        // A GET only shows what the POST would record: a prefetch or a scanner cannot pick a reason.
        if (!form) return reasonPage(ticketId, code, "", null, action);

        const note = (form.get("note") ?? "").trim();
        const state = await store.get(ticketId);
        state.reason = { code, note, at: now() };
        state.note = null;
        const held = state.pending;
        let recorded = "Reason recorded";
        if (held) {
          if (await file(state, { ...held.body, reason: note || null, reasonCode: code })) {
            state.pending = null;
            state.seenReplyId = held.replyId ?? state.seenReplyId;
          } else {
            state.pending = held;
            recorded = state.note ?? "Reason recorded; the capture is still waiting to be filed.";
          }
        }
        await store.set(ticketId, state);
        return reasonPage(ticketId, code, note, recorded, action);
      }

      if (url.pathname === "/gorgias/draft") {
        if (!linkAuthorized(url, "draft")) return json({ error: "link expired or unreadable" }, 403);
        const ticketId = url.searchParams.get("ticket_id") ?? "";
        const action = `/gorgias/draft?ticket_id=${encodeURIComponent(ticketId)}&${signedTail(url)}`;
        if (!form) return draftPage(ticketId, null, action);
        const origin = draftOriginFrom(form.get("source"));
        if (!origin) {
          return draftPage(ticketId, "Say where the text came from, so the scorecard can count it.", action);
        }
        const draft = draftFromHand(form.get("text") ?? "", settings, {
          origin,
          now: now(),
          fields: await readFields(ticketId),
        });
        if (!draft) {
          return draftPage(
            ticketId,
            `That is shorter than ${settings.minDraftChars} characters, so it is not a draft.`,
            action,
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

/** The draft page asks outright; anything else is not a source the scorecard may invent. */
function draftOriginFrom(raw: string | null): DraftOrigin | null {
  return raw === "assist" || raw === "human" || raw === "unknown" ? raw : null;
}
