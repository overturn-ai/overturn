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
| watches `ticket.comment.text` for an inserted draft | finds the run the drafting agent recorded (`externalId: "gr:<ticket id>"`), or takes the text the agent pastes into the Overturn page the card links to |
| blocks Submit until a reason is picked | files nothing until a reason is picked: the reply is already out, so the card asks after the fact instead of pretending to block |
| quick-pick chips in the iframe | one clickable row per reason code in the card |
| captures on submit | captures once Gorgias reports **`sent_datetime`** on the reply: creating a message and sending it are decoupled, and a message the customer never received is not a correction |

Everything else is the same payload, the same vocabulary (`draft`, `sent`, `reason`, `reasonCode`,
`draft:<origin>` tags) and the same rules as [`packages/zendesk-app`](../zendesk-app): the prose is
scored by the judge, decision fields are scored exactly, `tone_wording` is kept as evidence only.

## What the agent sees

The **Overturn** card in the ticket sidebar:

- **Draft inserted · 112 words** once the drafting agent's run is found for the ticket (the SDK
  recorded it as `gr:<ticket id>`), or **Draft marked by you · 112 words** after the agent pastes the
  text into the Overturn page and says whether the AI or they wrote it. Nothing is read before a
  draft exists — not the thread, not the fields.
- **Eight one-click reasons** — wrong answer, missing information, should have escalated, … — plus a
  note box on the page a reason opens. One click, then the page confirms.
- **Once Gorgias has sent the reply**, the app diffs draft against sent and files the capture: sent as
  drafted is an `approve`, changed is an `edit` with the reason as the case title. With
  `require_reason` on, a changed reply is held until a reason is picked — the card says so, and the
  send is never held back. The decision fields are frozen when the draft appears, so an agent editing
  a reserve while the AI's text sits in the reply box is caught rather than compared with itself.

Overturn failing never blocks the agent's work; the card says what happened and retries on the next
event.

## Install

1. In Overturn, create a project API key (Settings → API keys) and pick a workflow name (one
   regression suite per workflow, default `support-reply`).
2. Deploy the app: `node dist/main.js` behind HTTPS (Railway, Fly, a container — anything that keeps
   an env var secret). Required: `GORGIAS_DOMAIN`, `GORGIAS_EMAIL`, `GORGIAS_API_KEY` (Settings →
   REST API in Gorgias), `OVERTURN_API_KEY`, `APP_URL` (the public https URL the integration calls),
   and `WIDGET_TOKEN` — a shared secret of at least 24 characters. The app refuses to start without
   it: a Gorgias integration can only authenticate with a URL parameter, so a missing token would
   leave every route open to anyone who guessed the URL.
3. Register it in the helpdesk: `pnpm --filter @overturn-ai/gorgias-app build && node
   packages/gorgias-app/scripts/install.mjs`. It posts the integration and the widget (the payloads
   are in [`app/`](./app)) and prints their ids. Open a ticket: the card is in the right sidebar.
4. State survives a restart: the draft, the reason, the reply already accounted for and any capture
   waiting for a reason live in `DATA_FILE` (default `./data/gorgias-state.json`), written atomically
   after every change. Point it at a volume, or swap `src/store.ts` for Postgres or Redis when more
   than one instance serves the app.
5. Optional settings: `reason_pack` (`support` default, or `claims`), `require_reason`,
   `capture_internal_notes`, `decision_fields` (`status:status, 4509:order_id`), `order_fields`
   (`4509:order_id, 4510:shipping`), `min_draft_chars`, `scope_tag`, `OVERTURN_BASE_URL`
   (self-hosting).

`dist/overturn-gorgias-app.zip` is the same two payloads for an admin who would rather read them
first; Gorgias has no upload step.

### What goes in a URL, and what does not

The shared secret goes into the integration URL Gorgias stores, because that is the only place a
Gorgias integration can put it. Nothing else carries it: the links the card shows an agent are
HMAC-signed per action (`/gorgias/reason?ticket_id=…&code=…&exp=…&sig=…`) and expire after a day, so
a link in a browser history, a screenshot or a chat cannot be replayed for a different ticket, a
different reason or next month. Recording a reason takes a POST from that page; a GET only shows what
it would record, so a link preview or a mail scanner cannot pick a reason on the agent's behalf.

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/gorgias-app test        # payload builder, widget, links, store, routes
pnpm --filter @overturn-ai/gorgias-app typecheck
pnpm --filter @overturn-ai/gorgias-app build
```

- `src/capture.ts` — the logic, pure and tested: settings (including the config the app refuses to
  boot without), the thread, the draft and its frozen fields, when a reply counts as sent, the
  `POST /v1/capture` payload.
- `src/widget.ts` — the sidebar card, the JSON it renders, and the signed links on it.
- `src/sign.ts` — the HMAC that keeps the shared secret out of the agent's browser.
- `src/gorgias.ts`, `src/overturn.ts` — the two APIs the app talks to, over `fetch`.
- `src/store.ts` — the durable state: draft, reason, seen reply, spent runs, held captures.
- `src/handler.ts` — the routes Gorgias hits: the widget refresh (which is also the checkpoint), the
  reason page and its POST, the draft page. `src/main.ts` is the Node entry, `src/install.ts` the
  installer.
