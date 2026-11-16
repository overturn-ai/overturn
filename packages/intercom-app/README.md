# Overturn for Intercom

QA for AI-drafted replies, inside the Intercom inbox. An Intercom app (Canvas Kit, inbox surface) shows a small panel beside the conversation: the AI draft, where it came from, a one-click reason, and a Capture button. Capturing posts to `POST /v1/capture` with `source: "intercom"` and `externalId: "ic:<conversation id>"`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change.

## What the agent sees

- **Draft inserted · 112 words** once there is a draft: the output of a run your drafting agent recorded with the Overturn SDK (`externalId: "ic:<conversation id>"`, found automatically), or text pasted into the panel.
- A **reason** picker (`reason_pack`: `support` by default, or `claims`) and an optional note.
- **Capture this reply** compares the draft with the latest reply the agent sent in the conversation. Sent as drafted is an approve (no prompt); changed is an edit with the reason as the case title. With `require_reason` on, a changed reply is not captured until a reason is picked.

## What it cannot do

Canvas Kit is server-driven. Intercom calls our URLs when the panel opens or a button is pressed; it has no event for composer text and no hook on send. So the app does not watch the composer and cannot block or delay a send. It never gets in the way of the send: `require_reason` only holds back the capture, and an Overturn failure shows a message in the panel and nothing else.

## Where a draft came from

Origin is never guessed. A run found by conversation id is tagged `draft:ai`. Otherwise the agent says: "Written by an AI assist" is `draft:ai`, "I wrote it" is `draft:manual`, "Not sure" adds no `draft:*` tag, which the scorecard counts as unknown.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/intercom-app build` → `dist/overturn-intercom-app.zip` (a Node 22 server, `server.js`).
3. Run it where Intercom can reach it (`node server.js`) with:
   - `INTERCOM_CLIENT_SECRET`: verifies the `X-Body-Signature` of every request
   - `INTERCOM_ACCESS_TOKEN`: reads the conversation
   - `OVERTURN_API_KEY`
   - optional: `OVERTURN_BASE_URL` (self-hosting), `AGENT` (default `support-reply`), `REASON_PACK`, `REQUIRE_REASON` (default `true`), `CAPTURE_INTERNAL_NOTES`, `PORT`
4. In the Intercom Developer Hub, create an app, add the Inbox location and set the initialize, submit and configure URLs to `/initialize`, `/submit` and `/configure` on that host.

## Development

```bash
pnpm --filter @overturn-ai/intercom-app test
pnpm --filter @overturn-ai/intercom-app typecheck
pnpm --filter @overturn-ai/intercom-app build
```
