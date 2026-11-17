import Front, { HttpVerbsEnum } from "@frontapp/plugin-sdk";
import { settingsFromQuery } from "./capture";
import { createPlugin, type FrontContextLike, type FrontSdk, type PanelState } from "./plugin";

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

type WebViewContext = Parameters<NonNullable<Parameters<typeof Front.contextUpdates.subscribe>[0]>>[0];
type ConversationContext = Extract<WebViewContext, { type: "singleConversation" }>;
type DraftId = Parameters<ConversationContext["fetchDraft"]>[0];
type PageToken = Parameters<ConversationContext["listMessages"]>[0];

let latest: WebViewContext | null = null;
/** Conversation calls go to the latest context (Front's own advice); outside one, there is nothing to read. */
const conversationContext = (): ConversationContext => {
  if (latest?.type !== "singleConversation") throw new Error("no single conversation open");
  return latest;
};

/** The real SDK behind the narrow interface the plugin is written (and tested) against. */
const sdk: FrontSdk = {
  fetchDraft: async (id) => {
    const d = await conversationContext().fetchDraft(id as DraftId);
    return d ? { content: { body: d.content.body, type: d.content.type } } : undefined;
  },
  listMessages: (token) => conversationContext().listMessages(token as PageToken),
  listComments: (token) => conversationContext().listComments(token as PageToken),
  relayHttp: async (req) => {
    const r = await Front.relayHttp({
      verb: req.verb === "GET" ? HttpVerbsEnum.GET : HttpVerbsEnum.POST,
      url: req.url,
      ...(req.headers ? { headers: req.headers } : {}),
      ...(req.body !== undefined ? { body: req.body } : {}),
    });
    return { status: r.status, body: r.body };
  },
};

function main(): void {
  const settings = settingsFromQuery(location.search);
  const root = document.getElementById("app")!;
  const status = el("div", { class: "status" }, "Open a conversation");
  const hint = el("div", { class: "hint", role: "status" });
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const reason = el("textarea", { class: "reason", rows: "2", placeholder: "Anything else? Optional." });
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" });
  root.append(status, hint, quick, reason, mark, note);

  let chips: HTMLButtonElement[] = [];
  const render = (s: PanelState): void => {
    status.textContent = s.status;
    hint.textContent = s.hint;
    note.textContent = s.note;
    const watching = s.mode === "watching";
    quick.hidden = !watching;
    reason.hidden = !watching;
    mark.hidden = !watching;
    if (chips.length !== s.reasons.length) {
      quick.replaceChildren();
      chips = s.reasons.map((q) => {
        const b = el("button", { type: "button", class: "chip", "data-code": q.code }, q.label);
        b.addEventListener("click", () => void plugin.pickReason(q.code));
        quick.appendChild(b);
        return b;
      });
    }
    for (const c of chips) c.classList.toggle("on", c.dataset.code === s.reasonCode);
    if (!s.reasonCode && !s.pending && document.activeElement !== reason) reason.value = "";
  };

  const plugin = createPlugin({ front: sdk, settings, render });
  reason.addEventListener("input", () => plugin.setReasonNote(reason.value));
  mark.addEventListener("click", () => void plugin.markCurrent());

  Front.contextUpdates.subscribe((ctx) => {
    latest = ctx;
    const view: FrontContextLike =
      ctx.type === "singleConversation"
        ? { type: ctx.type, conversation: ctx.conversation, teammate: ctx.teammate }
        : { type: ctx.type, teammate: ctx.teammate };
    void plugin.onContext(view);
  });
  // Front pushes no update while the teammate types, so the open draft is re-read.
  setInterval(() => void plugin.poll(), 1000);
}

main();
