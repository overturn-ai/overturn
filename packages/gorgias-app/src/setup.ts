import { REASON_PACKS, type ReasonPack } from "@overturn-ai/shared/capture";

/**
 * The two Gorgias objects the install creates through the Gorgias REST API: the HTTP
 * integration that calls the handler on every new message, and the ticket sidebar widget
 * that shows its answer with one button per reason code. `scripts/package.mjs` writes both
 * into the zip with placeholders; README.md has the two curl calls.
 */

export function integrationBody(handlerUrl: string, secret: string) {
  return {
    name: "Overturn",
    description: "Captures what the AI drafted, what the agent sent and why (overturn.run)",
    type: "http",
    http: {
      url: `${handlerUrl.replace(/\/+$/, "")}/gorgias/event?ticket_id={{ticket.id}}`,
      method: "POST",
      headers: { "X-Overturn-Secret": secret },
      // Only new messages: a draft note landing, or the agent's reply going out.
      triggers: { "ticket-created": false, "ticket-message-created": true, "ticket-updated": false },
      request_content_type: "application/json",
      response_content_type: "application/json",
    },
  };
}

interface Field {
  key: string;
  label: string;
  value: string;
  editable: boolean;
  mandatory: boolean;
}
const field = (key: string, value: string, label = key, editable = false): Field => ({
  key,
  label,
  value,
  editable,
  mandatory: false,
});

export function widgetTemplate(handlerUrl: string, secret: string, settings: { reasonPack: ReasonPack }) {
  const url = `${handlerUrl.replace(/\/+$/, "")}/gorgias/reason`;
  const buttons = REASON_PACKS[settings.reasonPack].map((r) => ({
    label: r.label,
    action: {
      url,
      method: "POST",
      params: [],
      headers: [field("X-Overturn-Secret", secret)],
      body: {
        contentType: "application/x-www-form-urlencoded",
        "application/json": {},
        "application/x-www-form-urlencoded": [
          field("ticket_id", "{{ticket.id}}"),
          field("reason_code", r.code),
          field("actor", "{{current_user.email}}"),
          field("note", "", "Anything else? Optional.", true),
        ],
      },
    },
  }));
  return {
    context: "ticket",
    type: "http",
    order: 0,
    template: {
      type: "wrapper",
      widgets: [
        {
          path: "overturn",
          type: "card",
          title: "Overturn",
          order: 0,
          meta: { link: "", displayCard: true, custom: { links: [], buttons } },
          widgets: [
            { path: "status", type: "text", title: "Status", order: 0 },
            { path: "draft_words", type: "text", title: "Draft words", order: 1 },
            { path: "case_title", type: "text", title: "Case", order: 2 },
          ],
        },
      ],
    },
  };
}
