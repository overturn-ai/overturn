# Overturn for Gorgias

QA for AI-drafted replies, in the ticket sidebar. It shows what the AI drafted, files what the agent
actually sent, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft
becomes a recorded run, the difference becomes a case, and the suite replays it against any model
before the next prompt or model change. The drafting agent does not have to be instrumented, and it
does not matter who wrote the draft: Gorgias' AI Agent, another vendor, or a human.

Ecommerce teams are the ones asking for this, so the default reason pack is `support` and the order
context in the ticket sidebar travels with the capture.

## What Gorgias actually allows (read this first)

Zendesk has ZAF: a sandboxed iframe in the ticket sidebar that can watch the reply box. **Gorgias has
no such thing.** A Gorgias app is:

- a custom **HTTP integration** — Gorgias calls an HTTPS endpoint you own on `ticket-created`,
  `ticket-updated` and `ticket-message-created`, with variables like `{{ticket.id}}` substituted;
- a **sidebar widget** — a declarative card that renders the JSON that endpoint answered with.
  Rows can carry `meta.link`, which makes a row clickable;
- read-only otherwise: no iframe, no script in the helpdesk, and the REST API has no endpoint for the
  unsent reply box (checked against the API reference: messages are listed after they are sent).

So this app does the same job through the two things Gorgias does offer, and says so plainly:

| The Zendesk app | This app |
| --- | --- |
| watches `ticket.comment.text` for an inserted draft | finds the run the drafting agent recorded (`externalId: "gr:<ticket id>"`), or takes the text the agent pastes into the Overturn page |
| blocks Submit until a reason is picked | files nothing until a reason is picked (**never blocks the send**: there is nothing to block, the reply is already out) |
| quick-pick chips in the iframe | one clickable row per reason code in the card |

Everything else is the same payload, the same vocabulary (`draft`, `sent`, `reason`, `reasonCode`,
`draft:<origin>` tags) and the same rules as [`packages/zendesk-app`](../zendesk-app): the prose is
scored by the judge, decision fields are scored exactly, `tone_wording` is kept as evidence only.

## What the agent sees

The **Overturn** card in the ticket sidebar:

- **Draft inserted · 112 words** once the drafting agent's run is found for the ticket (the SDK
  recorded it as `gr:<ticket id>`), or **Draft marked by you · 112 words** after the agent pastes the
  text into the Overturn page. Nothing is read before a draft exists.
- **Eight one-click reasons** — wrong answer, missing information, should have escalated, … — plus a
  note box on the page a reason opens. One click is enough.
- **On the next ticket event** (the reply landing in the thread) the app diffs draft against sent and
  files the capture: sent as drafted is an `approve`, changed is an `edit` with the reason as the case
  title. With `require_reason` on, a changed reply is held until a reason is picked — the card says
  so, and the send is never held back.

Overturn failing never blocks the agent's work; the card says what happened and retries on the next
event.

## Install

1. In Overturn, create a project API key (Settings → API keys) and pick a workflow name (one
   regression suite per workflow, default `support-reply`).
2. Deploy the app: `node dist/main.js` behind HTTPS (Railway, Fly, a container — anything that keeps
   an env var secret). It needs `GORGIAS_DOMAIN`, `GORGIAS_EMAIL`, `GORGIAS_API_KEY` (Settings →
   REST API in Gorgias), `OVERTURN_API_KEY`, and `APP_URL` — the public URL the integration will call.
3. Register it in the helpdesk: `pnpm --filter @overturn-ai/gorgias-app build && node
   packages/gorgias-app/scripts/install.mjs`. It posts the integration and the widget (the payloads
   are in [`app/`](./app)) and prints their ids. Open a ticket: the card is in the right sidebar.
4. Optional settings: `WIDGET_TOKEN` (a shared secret the integration URL carries back),
   `reason_pack` (`support` default, or `claims`), `require_reason`, `capture_internal_notes`,
   `decision_fields` (`status:status, 4509:order_id`), `order_fields` (`4509:order_id, 4510:shipping`),
   `min_draft_chars`, `scope_tag`, `OVERTURN_BASE_URL` (self-hosting).

`dist/overturn-gorgias-app.zip` is the same two payloads for an admin who would rather read them
first; Gorgias has no upload step.

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/gorgias-app test        # payload builder, widget, install payloads, the routes
pnpm --filter @overturn-ai/gorgias-app typecheck
pnpm --filter @overturn-ai/gorgias-app build
```

- `src/capture.ts` — the logic, pure and tested: settings, the thread, the draft, the send decision,
  the `POST /v1/capture` payload.
- `src/widget.ts` — the sidebar card and the JSON it renders.
- `src/gorgias.ts`, `src/overturn.ts` — the two APIs the app talks to, over `fetch`.
- `src/handler.ts` — the routes Gorgias hits: the widget refresh (which is also the checkpoint),
  the one-click reason, the draft page. `src/main.ts` is the Node entry, `src/install.ts` the
  installer. The store is in-process by default (`createMemoryStore`); swap it for Redis or Postgres
  when more than one process serves the app.
