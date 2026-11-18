import type { ReasonCodeOption } from "@overturn-ai/shared/capture";
import type { AppSettings, DraftState, LastResult, TicketSnapshot } from "./capture";
import { orderContext, quickReasons, statusLine } from "./capture";

/** One row of the sidebar card. */
export interface WidgetRow {
  /** The reason code, or "note" for the row that opens the note form. */
  code: string;
  label: string;
  hint: string;
  /** Where the row goes when the agent clicks it. */
  link: string;
}

/** What the integration answers; the widget template reads these paths. */
export interface WidgetData {
  status: string;
  ticket_id: string;
  order: string | null;
  note: string | null;
  reasons: WidgetRow[];
  notes: WidgetRow[];
}

/** One node of the Gorgias widget template. */
export interface WidgetTemplateNode {
  type: string;
  title?: string;
  path?: string;
  meta?: Record<string, unknown>;
  widgets?: WidgetTemplateNode[];
}

export interface WidgetDataOptions {
  ticket: TicketSnapshot;
  draft: DraftState | null;
  lastResult: LastResult | null;
  settings: AppSettings;
  /** The public base URL of this app; the reason rows link back to it. */
  appBaseUrl: string;
  /** Set when a capture is waiting for a reason code. */
  pendingReason: boolean;
  /** The note the agent added, when there is one. */
  note?: string | null;
}

function reasonLink(appBaseUrl: string, ticketId: string, code: string): string {
  const url = new URL("/gorgias/reason", appBaseUrl);
  url.searchParams.set("ticket_id", ticketId);
  url.searchParams.set("code", code);
  return url.toString();
}

function noteLink(appBaseUrl: string, ticketId: string): string {
  const url = new URL("/gorgias/reason", appBaseUrl);
  url.searchParams.set("ticket_id", ticketId);
  return url.toString();
}

/** The order the ticket is about, as one line for the card. */
export function orderLine(ticket: TicketSnapshot): string | null {
  const order = orderContext(ticket);
  if (!order) return null;
  const id = order.id === undefined ? "" : String(order.id);
  const total = order.total === undefined || order.total === null ? null : String(order.total);
  const currency = order.currency === undefined || order.currency === null ? null : String(order.currency);
  const amount = total && currency ? ` ${total} ${currency}` : total ? ` ${total}` : "";
  return `Order #${id}${amount}`;
}

/**
 * The rows the sidebar shows.
 *
 * Gorgias renders the rows as a list of cards: every card's title is a link, so the reason
 * codes are one click each and the capture happens when the agent clicks.
 */
export function widgetRows(options: WidgetDataOptions): { reasons: WidgetRow[]; notes: WidgetRow[] } {
  const ticketId = String(options.ticket.id);
  const reasons: WidgetRow[] = [];
  if (options.pendingReason) {
    for (const option of quickReasons(options.settings)) {
      reasons.push({
        code: option.code,
        label: option.label,
        hint: "Click to capture the correction with this reason",
        link: reasonLink(options.appBaseUrl, ticketId, option.code),
      });
    }
  }
  const notes: WidgetRow[] = options.pendingReason
    ? [
        {
          code: "note",
          label: "Add a note",
          hint: "Capture the correction with a note as well",
          link: noteLink(options.appBaseUrl, ticketId),
        },
      ]
    : [];
  return { reasons, notes };
}

/** The data the integration answers with. */
export function widgetData(options: WidgetDataOptions): WidgetData {
  const { reasons, notes } = widgetRows(options);
  return {
    status: statusLine(options.draft, options.lastResult),
    ticket_id: String(options.ticket.id),
    order: orderLine(options.ticket),
    note: options.note ?? null,
    reasons,
    notes,
  };
}

/**
 * The Gorgias widget template.
 *
 * The paths are the keys of the data the integration answers with (`status`, `order`,
 * `captured`, `reasons`, `notes`); a list row's `{{label}}`, `{{hint}}` and `{{link}}`
 * are read from the row itself, so a reason code is one click and the click carries the code.
 */
export function widgetTemplate(): WidgetTemplateNode {
  const listCard: WidgetTemplateNode = {
    type: "card",
    title: "{{label}}",
    path: "",
    meta: { displayCard: true, link: "{{link}}" },
    widgets: [{ type: "text", title: "Why", path: "hint" }],
  };
  return {
    type: "wrapper",
    widgets: [
      {
        type: "card",
        title: "Overturn",
        path: "",
        meta: { displayCard: true },
        widgets: [
          { type: "text", title: "Status", path: "status" },
          { type: "text", title: "Order", path: "order" },
          { type: "text", title: "Note", path: "note" },
          { type: "list", title: "Why did you change it?", path: "reasons", widgets: [listCard] },
          { type: "list", title: "Note", path: "notes", widgets: [listCard] },
        ],
      },
    ],
  };
}

/** The reason codes the card offers, for the README and the install log. */
export function reasonOptions(settings: AppSettings): readonly ReasonCodeOption[] {
  return quickReasons(settings);
}
