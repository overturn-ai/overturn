import { type AppSettings, quickReasons, settingsFrom } from "./capture";
import { type ConversationView, createController } from "./glue";

/** The slice of the Front plugin SDK (the `Front` global from frontjs) this plugin uses. */
interface FrontAuthor {
  email?: string | null;
  username?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}
interface FrontMessageRaw {
  id: string;
  is_inbound: boolean;
  author?: FrontAuthor | null;
  content?: { body?: string } | null;
  created_at?: number | string | null;
}
interface FrontCommentRaw {
  id: string;
  author?: FrontAuthor | null;
  body?: string;
  posted_at?: number | string | null;
}
interface FrontContext {
  type: string;
  teammate?: { email?: string | null };
  conversation?: {
    id: string;
    subject?: string | null;
    recipient?: { handle?: string | null; name?: string | null } | null;
  };
  /** The reply box, present while a composer is open on the conversation. */
  draft?: { content?: { body?: string } | null } | null;
  listMessages(): Promise<{ results: FrontMessageRaw[] }>;
  listComments(): Promise<{ results: FrontCommentRaw[] }>;
}
declare global {
  interface Window {
    Front: { contextUpdates: { subscribe(handler: (context: FrontContext) => void): unknown } };
  }
}

const STORAGE_KEY = "overturn-front-config";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}

function iso(t: number | string | null | undefined): string | null {
  if (t === null || t === undefined) return null;
  // Front timestamps are epoch seconds.
  const d = typeof t === "number" ? new Date(t * 1000) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function name(a: FrontAuthor | null | undefined): string | null {
  if (!a) return null;
  return [a.first_name, a.last_name].filter(Boolean).join(" ") || a.username || null;
}

function viewOf(ctx: FrontContext): ConversationView | null {
  if (ctx.type !== "singleConversation" || !ctx.conversation) return null;
  const c = ctx.conversation;
  return {
    id: c.id,
    subject: c.subject ?? null,
    recipient: c.recipient?.handle ?? null,
    url: `https://app.frontapp.com/open/${c.id}`,
    actor: ctx.teammate?.email ?? null,
    draftText: ctx.draft ? (ctx.draft.content?.body ?? "") : null,
    async listMessages() {
      const { results } = await ctx.listMessages();
      return results.map((m) => ({
        id: m.id,
        body: m.content?.body ?? "",
        isInbound: m.is_inbound,
        authorName: name(m.author),
        authorEmail: m.author?.email ?? null,
        createdAt: iso(m.created_at),
      }));
    },
    async listComments() {
      const { results } = await ctx.listComments();
      return results.map((m) => ({
        id: m.id,
        body: m.body ?? "",
        authorName: name(m.author),
        createdAt: iso(m.posted_at),
      }));
    },
  };
}

function loadConfig(): Record<string, unknown> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function renderConfigForm(root: HTMLElement): void {
  const form = el("form", { class: "config" });
  const field = (key: string, placeholder: string, type = "text") => {
    form.appendChild(el("input", { name: key, placeholder, type, autocomplete: "off" }));
  };
  field("overturn_api_key", "Overturn project API key", "password");
  field("agent", "Workflow name (default support-reply)");
  field("reason_pack", "Reasons: support (default) or claims");
  field("require_reason", "Require a reason for changed replies (true/false)");
  field("overturn_base_url", "API URL (default https://api.overturn.run)");
  form.appendChild(el("button", { type: "submit", class: "chip" }, "Save"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const out: Record<string, string> = {};
    for (const i of Array.from(form.querySelectorAll("input"))) {
      if (i.value.trim()) out[i.name] = i.value.trim();
    }
    if (!out.overturn_api_key) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    location.reload();
  });
  root.appendChild(form);
}

function main(): void {
  const root = document.getElementById("app");
  if (!root) return;
  const config = loadConfig();
  const apiKey = typeof config?.overturn_api_key === "string" ? config.overturn_api_key : "";
  if (!config || !apiKey) {
    root.appendChild(el("div", { class: "status" }, "Set up Overturn"));
    renderConfigForm(root);
    return;
  }
  const settings: AppSettings = settingsFrom(config);

  const status = el("div", { class: "status" }, "Waiting for a draft");
  let reasonCode: string | null = null;
  const quick = el("div", { class: "quick", role: "radiogroup", "aria-label": "Why did you change it?" });
  const chips: HTMLButtonElement[] = [];
  const reason = el("textarea", {
    class: "reason",
    rows: "2",
    placeholder: "Anything else? Optional.",
  }) as HTMLTextAreaElement;
  const mark = el("button", { type: "button", class: "link" }, "Use the current text as the draft");
  const note = el("div", { class: "note" }, "");
  root.append(status, quick, reason, mark, note);

  let latest: ConversationView | null = null;
  const render = (): void => {
    const s = controller.state();
    status.textContent = s.status;
    note.textContent = s.note;
    if (!s.status.startsWith("Draft") && !s.needsReason) {
      reason.value = "";
      reasonCode = null;
      for (const c of chips) c.classList.remove("on");
    }
  };
  const controller = createController({
    settings,
    apiKey,
    fetch: (input, init) => fetch(input, init),
    onChange: render,
  });

  for (const q of quickReasons(settings)) {
    const b = el(
      "button",
      { type: "button", class: "chip", "data-code": q.code },
      q.label,
    ) as HTMLButtonElement;
    b.addEventListener("click", () => {
      reasonCode = reasonCode === q.code ? null : q.code;
      for (const c of chips) c.classList.toggle("on", c.dataset.code === reasonCode);
      void controller.setReason(reasonCode, reason.value).then(render);
    });
    chips.push(b);
    quick.appendChild(b);
  }
  reason.addEventListener("change", () => void controller.setReason(reasonCode, reason.value));
  mark.addEventListener("click", () => {
    if (latest) void controller.markDraft(latest).then(render);
  });

  window.Front.contextUpdates.subscribe((ctx) => {
    const view = viewOf(ctx);
    latest = view;
    if (!view) return;
    void controller.onConversation(view).then(render);
  });
}

main();
