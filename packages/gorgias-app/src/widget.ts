import { type AppSettings, type DraftState, quickReasons, statusLine } from "./capture";

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
  [row: `reason_${string}`]: string;
}

/** The query the app adds so a link can be trusted as far as the integration URL is. */
export function tokenQuery(settings: AppSettings): string {
  return settings.widgetToken ? `&token=${encodeURIComponent(settings.widgetToken)}` : "";
}

/** The one-click reason: the row records the reason for this ticket, no second click needed. */
export function reasonUrl(settings: AppSettings, ticketId: string | number, code: string): string {
  const id = encodeURIComponent(String(ticketId));
  const c = encodeURIComponent(code);
  return `${settings.appUrl}/gorgias/reason?ticket_id=${id}&code=${c}${tokenQuery(settings)}`;
}

/** The page where the agent pastes the text that is in the reply box, when nothing recorded it. */
export function draftUrl(settings: AppSettings, ticketId: string | number): string {
  const id = encodeURIComponent(String(ticketId));
  return `${settings.appUrl}/gorgias/draft?ticket_id=${id}${tokenQuery(settings)}`;
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
  };
  for (const q of quickReasons(input.settings)) {
    rows[`reason_${q.code}`] = input.reasonCode === q.code ? "recorded ✓" : "record · one click";
    rows[`reason_${q.code}_url`] = reasonUrl(input.settings, input.ticketId, q.code);
  }
  return rows;
}
