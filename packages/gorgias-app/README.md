# Overturn for Gorgias

QA for AI-drafted replies, in the Gorgias ticket sidebar. An HTTP integration tells this app about every ticket event. Once a ticket has an AI draft, the app diffs the draft against the reply the agent actually sent, takes a one-click reason from the sidebar widget, and posts the result to `POST /v1/capture` with `source: "gorgias"` and `externalId: "gr:<ticket id>"`.

Ecommerce teams are the first users, so the defaults lean that way: the `support` reason pack, and the customer's recent orders (number, total, payment and fulfillment status, date) carried along as context. Addresses and payment details are never copied.

## What the agent sees

The widget shows the HTTP integration's response:

- **Draft inserted · N words** once there is a draft. Drafts come from one of two places:
  - a drafting agent that recorded its run with the Overturn SDK (`externalId: "gr:<ticket id>"`), tagged `draft:recorded`
  - the drafting tool calling `POST /draft` when it puts the draft in the reply box, tagged `draft:inserted`
- **Reason links**, one per code in the pack (`support` by default, `claims` optional). One click saves the reason. A macro that adds a tag like `overturn:wrong_answer` works too.
- When the reply goes out: sent as drafted is an approve; changed is an edit. With `require_reason` on (default), a changed reply's capture waits until a reason is picked: **Pick why you changed the reply**.

The send is never held, and a failed capture is acknowledged and shown in the widget.

A ticket without a draft is never read: the app makes no Gorgias API call for it.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build and deploy: `pnpm --filter @overturn-ai/gorgias-app build` → `dist/overturn-gorgias-app.zip` (or `dist/app/`). Run it with `node main.js` on any HTTPS host.
3. Environment:
   - `OVERTURN_API_KEY` (required, stays on the server)
   - `GORGIAS_URL` (`https://<account>.gorgias.com`), `GORGIAS_USERNAME`, `GORGIAS_API_KEY` (REST API, read tickets)
   - `OVERTURN_GORGIAS_TOKEN`: a random secret, sent by the integration and used to sign the reason links
   - `PUBLIC_URL`: where this app is reachable
   - Optional: `OVERTURN_AGENT` (default `support-reply`), `OVERTURN_REASON_PACK`, `OVERTURN_REQUIRE_REASON`, `OVERTURN_CAPTURE_INTERNAL_NOTES`, `OVERTURN_DECISION_FIELDS` (ticket custom fields as `field_id:label`), `OVERTURN_MIN_DRAFT_CHARS`, `OVERTURN_MAX_ORDERS` (default 3), `OVERTURN_BASE_URL`, `PORT`
4. In Gorgias, go to Settings → HTTP integration → Add:
   - URL: `https://<host>/events`, method `POST`, header `X-Overturn-Token: <token>`
   - Body (JSON): `{ "ticket_id": "{{ticket.id}}" }`
   - Triggers: Ticket created, Ticket updated, Ticket message created
5. Open a ticket. Under Custom integrations, drag the `overturn` section into the sidebar and show `status`, `message` and `reasons[].url` (as links labelled by `reasons[].label`).
6. Drafting tool: `POST https://<host>/draft` with `X-Overturn-Token` and `{ "ticket_id": 9001, "text": "...", "model": "gpt-4.1-mini" }`.

The default store is in memory (one process). For several instances, pass a shared `Store` to `createApp`.

## Development

```bash
pnpm --filter @overturn-ai/gorgias-app test
pnpm --filter @overturn-ai/gorgias-app build
```

`src/capture.ts` holds the logic (pure, tested), `src/app.ts` handles events, drafts and reasons (tested with mocked Gorgias and Overturn APIs), and `src/main.ts` is the Node server.
