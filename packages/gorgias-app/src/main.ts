import type { CaptureResult } from "@overturn-ai/shared";
import {
  type AppSettings,
  type DraftState,
  decideOnSend,
  inScope,
  latestAgentSend,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";
import { createGorgiasClient, gorgiasCredentials } from "./gorgias-client";

interface GorgiasWidgetWindow extends Window {
  /** Settings arrive as URL query parameters; tests inject them here instead. */
  __OVERTURN_SETTINGS__?: Record<string, unknown>;
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

function readParams(win: GorgiasWidgetWindow): Record<string, unknown> {
  const query: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(location.search)) query[k] = v;
  return { ...query, ...(win.__OVERTURN_SETTINGS__ ?? {}) };
}

function apiKey(params: Record<string, unknown>): string {
  const injected = params.overturn_api_key;
  return typeof injected === "string" ? injected : "";
}

/**
 * The run a drafting agent recorded with the Overturn SDK for this ticket, when there is one.
 * Gorgias has no composer API, so that run is the draft: it carries the text and the moment
 * the assist wrote it. When there is no recorded run, the newest agent message is offered as
 * the draft to mark by hand.
 */
async function findRecordedDraft(
  baseUrl: string,
  key: string,
  externalId: string,
  agent: string,
): Promise<DraftState | null> {
  try {
    const url = `${baseUrl}/v1/runs?externalId=${encodeURIComponent(externalId)}&agent=${encodeURIComponent(agent)}&limit=1`;
    const res = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const found = (await res.json()) as {
      items: Array<{ id: string; output: unknown; model?: string | null }>;
    };
    const run = found.items?.[0];
    if (run && typeof run.output === "string" && run.output.trim()) {
      return {
        text: run.output,
        origin: "recorded",
        runId: run.id,
        model: run.model ?? null,
        at: Math.floor(Date.now() / 1000),
      };
    }
  } catch {
    // no recorded draft; the agent marks the draft by hand instead
  }
  return null;
}

async function main(): Promise<void> {
  const win = window as GorgiasWidgetWindow;
  const params = readParams(win);
  const settings: AppSettings = settingsFrom(params);
  const key = apiKey(params);
  const ticketId = String(params.ticket_id ?? params.ticketId ?? "");
  const creds = gorgiasCredentials(params);

  const root = document.getElementById("app")!;
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
  const mark = el("button", { type: "button", class: "link" }, "Use the newest reply as the draft");
  const capture = el("button", { type: "button", class: "primary" }, "Capture this send");
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, mark, capture, note);

  if (!creds || !ticketId) {
    status.textContent = "Not configured: add the Gorgias REST credentials and a ticket id.";
    quick.remove();
    reason.remove();
    mark.remove();
    capture.remove();
    return;
  }

  // `gorgias_base_url` is the account's own API host (e.g. https://acme.gorgias.com);
  // `settings.baseUrl` is Overturn's API, a different service entirely.
  const gorgiasBase = typeof params.gorgias_base_url === "string" ? params.gorgias_base_url : "";
  const client = createGorgiasClient({
    baseUrl: gorgiasBase,
    username: creds.username,
    apiKey: creds.apiKey,
  });

  let draft: DraftState | null = null;
  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(draft, lastResult);
  };

  const ticket = await client.getTicket(ticketId);
  if (!inScope(ticket.tags, settings)) {
    status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
    quick.remove();
    reason.remove();
    mark.remove();
    capture.remove();
    return;
  }

  draft = await findRecordedDraft(settings.baseUrl, key, `gr:${ticket.id}`, settings.agent);
  render();

  mark.addEventListener("click", () => {
    const sent = latestAgentSend(ticket, null);
    if (!sent?.text.trim()) return;
    draft = { text: sent.text, origin: "manual", at: sent.at ?? Math.floor(Date.now() / 1000) };
    lastResult = null;
    render();
  });

  capture.addEventListener("click", async () => {
    const send = latestAgentSend(ticket, draft);
    const decision = decideOnSend({
      ticket,
      draft,
      draftFields: ticket.fields,
      send,
      sendFields: ticket.fields,
      reasonCode,
      reason: reason.value,
      actor: ticket.assigneeEmail,
      settings,
      now: Math.floor(Date.now() / 1000),
    });
    if (decision.action === "skip") {
      note.textContent = `Nothing to capture (${decision.why}).`;
      return;
    }
    if (decision.action === "need-reason") {
      chips[0]?.focus();
      const what = decision.changedFields.length ? decision.changedFields.join(", ") : "reply";
      note.textContent = `Pick why you changed the ${what} (one click).`;
      return;
    }
    try {
      const res = await fetch(`${settings.baseUrl}/v1/capture`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(decision.body),
      });
      const r = (await res.json()) as CaptureResult;
      lastResult = { kind: r.kind, changed: r.changed, dedup: r.deduplicated };
      note.textContent = r.changed && r.case ? `Case: ${r.case.title}` : "";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      draft = null;
      render();
    } catch (e) {
      // Never block the agent's work on our failure; say so in the panel.
      note.textContent = `Overturn could not save this correction (${(e as { status?: number }).status ?? "network"}).`;
    }
  });
}

if (typeof document !== "undefined") {
  void main();
}
