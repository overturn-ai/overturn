import {
  type AppSettings,
  createDraftDetector,
  type DraftState,
  decideOnSend,
  type FetchLike,
  type GorgiasMessageItem,
  type GorgiasOrderContext,
  type GorgiasTicketSnapshot,
  inScope,
  postCapture,
  quickReasons,
  settingsFrom,
  statusLine,
} from "./capture";

export interface GorgiasHostMessage {
  id?: number;
  body_html?: string;
  body_text?: string;
  from_agent?: boolean;
  channel?: string;
  sender?: { email?: string; name?: string };
  created_datetime?: string;
}

export interface GorgiasHostTicket {
  id: number | string;
  subject?: string;
  customer?: { email?: string; name?: string };
  tags?: Array<{ name: string }>;
  custom_fields?: Record<string, unknown>;
  order?: GorgiasOrderContext;
  messages?: GorgiasHostMessage[];
  reply_box_text?: string;
  uri?: string;
}

export interface GorgiasWidgetBridge {
  getTicket(): Promise<GorgiasHostTicket>;
  getCurrentAgent?(): Promise<{ email?: string; name?: string }>;
  onReplyBoxChange?(cb: (text: string) => void): void;
  onMessageSend?(cb: (payload: { body: string; isInternalNote?: boolean }) => void): void;
}

declare global {
  interface Window {
    GorgiasWidget?: GorgiasWidgetBridge;
    OVERTURN_GORGIAS_SETTINGS?: Record<string, unknown>;
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

function querySettings(): Record<string, unknown> {
  const params = new URLSearchParams(window.location.search);
  const raw: Record<string, unknown> = { ...(window.OVERTURN_GORGIAS_SETTINGS ?? {}) };
  params.forEach((v, k) => {
    raw[k] = v;
  });
  return raw;
}

function mapFields(
  customFields: Record<string, unknown> | undefined,
  settings: AppSettings,
): Record<string, unknown> {
  if (settings.decisionFields.length === 0) return {};
  const src = customFields ?? {};
  return Object.fromEntries(settings.decisionFields.map((f) => [f.label, src[f.id] ?? null]));
}

function mapMessages(items: GorgiasHostMessage[] | undefined): GorgiasMessageItem[] {
  return (items ?? []).map((m) => ({
    id: m.id,
    bodyHtml: m.body_html ?? "",
    bodyText: m.body_text ?? null,
    fromAgent: Boolean(m.from_agent),
    isInternalNote: m.channel === "internal-note",
    senderEmail: m.sender?.email ?? null,
    senderName: m.sender?.name ?? null,
    createdAt: m.created_datetime ?? null,
  }));
}

export async function initGorgiasApp(): Promise<void> {
  const root = document.getElementById("app");
  if (!root || !window.GorgiasWidget) return;

  const bridge = window.GorgiasWidget;
  const settings = settingsFrom(querySettings());
  const detector = createDraftDetector({ minDraftChars: settings.minDraftChars });

  const status = el("div", { class: "status" }, "Waiting for a draft");
  let reasonCode: string | null = null;
  const quick = el("div", {
    class: "quick",
    role: "radiogroup",
    "aria-label": "Why did you change it?",
  });
  const chips: HTMLButtonElement[] = [];
  for (const q of quickReasons(settings)) {
    const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label);
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
  });
  const actions = el("div", { class: "actions" });
  const mark = el("button", { type: "button", class: "link" }, "Use current text as draft");
  const sendBtn = el("button", { type: "button", class: "link" }, "Capture send");
  actions.append(mark, sendBtn);
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, actions, note);

  let lastResult: { kind: string; changed: boolean; dedup: boolean } | null = null;
  const render = (): void => {
    status.textContent = statusLine(detector.current(), lastResult);
  };

  const initial = await bridge.getTicket();
  const tags = (initial.tags ?? []).map((t) => t.name);
  if (!inScope(tags, settings)) {
    status.textContent = `Not watching: no "${settings.scopeTag}" tag`;
    quick.remove();
    reason.remove();
    actions.remove();
    return;
  }

  const draftFields = mapFields(initial.custom_fields, settings);
  if (initial.reply_box_text) {
    detector.onComposer(initial.reply_box_text);
  }
  render();

  bridge.onReplyBoxChange?.((text) => {
    if (detector.onComposer(text)) render();
  });

  mark.addEventListener("click", async () => {
    const latest = await bridge.getTicket();
    const text = latest.reply_box_text ?? "";
    if (!text.trim()) return;
    detector.set({ text, origin: "manual", at: Date.now() });
    lastResult = null;
    note.textContent = "";
    render();
  });

  const handleSend = async (sentBody?: string, isInternalNote = false): Promise<void> => {
    const draft: DraftState | null = detector.current();
    // Never read ticket messages unless a draft exists.
    if (!draft) return;

    const latest = await bridge.getTicket();
    const snapshot: GorgiasTicketSnapshot = {
      id: latest.id,
      subject: latest.subject ?? null,
      customerEmail: latest.customer?.email ?? null,
      customerName: latest.customer?.name ?? null,
      messages: mapMessages(latest.messages),
      fields: mapFields(latest.custom_fields, settings),
      order: latest.order ?? null,
      tags: (latest.tags ?? []).map((t) => t.name),
      url: latest.uri ?? null,
    };

    const agent = bridge.getCurrentAgent ? await bridge.getCurrentAgent() : null;
    const decision = decideOnSend({
      ticket: snapshot,
      draft,
      draftFields,
      send: {
        text: sentBody ?? latest.reply_box_text ?? "",
        type: isInternalNote ? "internalNote" : "publicReply",
        fields: snapshot.fields,
      },
      reasonCode,
      reason: reason.value,
      actor: agent?.email ?? agent?.name ?? null,
      settings,
      now: Date.now(),
    });

    if (decision.action === "skip") return;
    if (decision.action === "need-reason") {
      chips[0]?.focus();
      note.textContent = `Overturn: pick why you changed the ${decision.changedFields.length ? decision.changedFields.join(", ") : "reply"} before sending.`;
      return;
    }

    const outcome = await postCapture(fetch as unknown as FetchLike, settings, decision.body);
    if (outcome.ok) {
      lastResult = {
        kind: outcome.result.kind,
        changed: outcome.result.changed,
        dedup: outcome.result.deduplicated,
      };
      note.textContent =
        outcome.result.changed && outcome.result.case ? `Case: ${outcome.result.case.title}` : "";
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
      detector.set(null);
      render();
    } else {
      note.textContent = `Overturn could not save this correction (${outcome.status}).`;
    }
  };

  sendBtn.addEventListener("click", () => void handleSend());
  bridge.onMessageSend?.((payload) => void handleSend(payload.body, Boolean(payload.isInternalNote)));
}

if (typeof document !== "undefined") {
  void initGorgiasApp();
}
