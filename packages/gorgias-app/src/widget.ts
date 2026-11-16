import { type AppSettings, type DraftState, quickReasons, statusLine } from "./capture";
import { signLink } from "./sign";

/** One element of a Gorgias widget template. https://developers.gorgias.com/reference/the-widget-object */
export interface WidgetElement {
  type: "wrapper" | "card" | "text";
  title?: string;
  /** Where the value lives in the integration's JSON response; `""` is the response root. */
  path?: string;
  meta?: { displayCard?: boolean; link?: string };
  widgets?: WidgetElement[];
}

export interface WidgetDefinition {
  name: string;
  /** `ticket` puts it in the ticket sidebar, next to the reply box. */
  context: "ticket";
  type: "http";
  order: number;
  /** One widget per HTTP integration, so install.mjs posts one of these per helpdesk. */
  template: WidgetElement;
}

export const WIDGET_NAME = "Overturn";

/**
 * The sidebar card: the status line, what the app is waiting for, and one row per reason code.
 * Each reason row is a link, because a Gorgias widget is data, not a page: there is no reply box
 * to watch and no click handler to run. The card title links to the app, where the draft text and
 * the optional note live.
 */
export function buildWidgetTemplate(settings: AppSettings): WidgetDefinition {
  return {
    name: WIDGET_NAME,
    context: "ticket",
    type: "http",
    order: 3,
    template: {
      type: "wrapper",
      widgets: [
        {
          type: "card",
          title: WIDGET_NAME,
          path: "",
          meta: { displayCard: true, link: "{{app_url}}" },
          widgets: [
            { type: "text", title: "Status", path: "status" },
            { type: "text", title: "Detail", path: "detail" },
            {
              type: "text",
              title: "Put the draft text in Overturn",
              path: "draft_action",
              meta: { link: "{{draft_url}}" },
            },
            ...quickReasons(settings).map((q) => ({
              type: "text" as const,
              title: q.label,
              path: `reason_${q.code}`,
              meta: { link: `{{reason_${q.code}_url}}` },
            })),
          ],
        },
      ],
    },
  };
}

/** The JSON the integration returns; the template above reads these paths off its root. */
export interface WidgetData {
  app_url: string;
  status: string;
  detail: string;
  /** Where the agent pastes the text that is in the reply box, when nothing recorded it. */
  draft_action: string;
  draft_url: string;
  [row: `reason_${string}`]: string;
}

/** The signed links the card shows: the secret stays in the app, never in the agent's browser. */
export interface LinkSigner {
  reason(ticketId: string | number, code: string): string;
  draft(ticketId: string | number): string;
}

/** The query a signed link carries: what it authorizes, when it dies, and the signature. */
function signedQuery(exp: number, sig: string): string {
  return `&exp=${exp}&sig=${sig}`;
}

/**
 * Builds the two links the card can offer. Both are HMAC-signed (see sign.ts): the app's shared
 * secret goes into Gorgias' integration URL once, and no link an agent sees ever carries it.
 */
export function linkSigner(secret: string, now?: () => number): LinkSigner {
  const at = now ?? (() => Date.now());
  return {
    reason(ticketId, code) {
      const id = String(ticketId);
      const { exp, sig } = signLink(secret, "reason", id, { extra: code, now: at() });
      return `/gorgias/reason?ticket_id=${encodeURIComponent(id)}&code=${encodeURIComponent(code)}${signedQuery(exp, sig)}`;
    },
    draft(ticketId) {
      const id = String(ticketId);
      const { exp, sig } = signLink(secret, "draft", id, { now: at() });
      return `/gorgias/draft?ticket_id=${encodeURIComponent(id)}${signedQuery(exp, sig)}`;
    },
  };
}

/** Absolute URLs for the widget: Gorgias renders `meta.link` as-is, so the host has to be in them. */
export function absolute(appUrl: string, path: string): string {
  return `${appUrl.replace(/\/+$/, "")}${path}`;
}

/** The one-click reason: the row records the reason for this ticket, no second click needed. */
export function reasonUrl(settings: AppSettings, ticketId: string | number, code: string): string {
  return absolute(settings.appUrl, linkSigner(settings.widgetToken ?? "").reason(ticketId, code));
}

/** The page where the agent pastes the text that is in the reply box, when nothing recorded it. */
export function draftUrl(settings: AppSettings, ticketId: string | number): string {
  return absolute(settings.appUrl, linkSigner(settings.widgetToken ?? "").draft(ticketId));
}

export function widgetData(input: {
  settings: AppSettings;
  ticketId: string | number;
  draft: DraftState | null;
  lastResult: { kind: string; changed: boolean } | null;
  /** Why a changed reply is not filed yet, or what failed. Empty when nothing needs saying. */
  detail: string | null;
  /** The reason already on file for this ticket. */
  reasonCode: string | null;
}): WidgetData {
  const rows: WidgetData = {
    app_url: input.settings.appUrl,
    status: statusLine(input.draft, input.lastResult),
    detail: input.detail ?? "",
    draft_action: input.draft ? "Replace the draft text" : "No recorded draft? Paste it here",
    draft_url: draftUrl(input.settings, input.ticketId),
  };
  for (const q of quickReasons(input.settings)) {
    rows[`reason_${q.code}`] = input.reasonCode === q.code ? "recorded ✓" : "record · one click";
    rows[`reason_${q.code}_url`] = reasonUrl(input.settings, input.ticketId, q.code);
  }
  return rows;
}
