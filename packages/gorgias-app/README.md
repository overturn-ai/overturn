# Overturn for Gorgias

QA for AI-drafted replies, in the Gorgias ticket sidebar. It finds the AI draft on the ticket, diffs it against what the agent actually sent, asks for a one-click reason, and posts the result to `POST /v1/capture` with `source: "gorgias"` and `externalId: "gr:<ticket id>"`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. Gorgias teams are mostly ecommerce teams, so the customer's latest order (number, payment and fulfilment status, total) rides along in the capture's `context` and `metadata`, and the `support` reason pack is the default.

## How it fits Gorgias

Gorgias has no client-side app framework like Zendesk's ZAF: a third party cannot read the reply box or hold a send. What it does have, and what this app uses:

- an **HTTP integration** that Gorgias calls on *ticket message created*, with `{{ticket.id}}` in the URL;
- a **ticket sidebar widget** that renders the JSON that integration returned, with **custom action buttons** that make HTTP calls (with `{{ticket.id}}`, `{{current_user.email}}` and an editable note);
- the **REST API**, to read the ticket and its messages.

So the app is a small handler you deploy (`dist/app/server.js` on Node 22, or `handler.js` as a fetch handler on Workers, Deno or Bun), plus the integration and the widget, created once. All keys stay in the handler's environment; nothing secret goes to the agent's browser.

| Zendesk app | Gorgias app |
| --- | --- |
| Draft inserted into the reply box | Draft lands on the ticket as an internal note from the drafting AI (starts with `[AI draft]`, or is written by a `DRAFT_AUTHORS` user), or the drafting agent recorded its run with the SDK under `externalId: "gr:<ticket id>"` |
| `Draft inserted · N words` in the sidebar | The same line in the Overturn widget, as soon as the note lands |
| Reason chips + optional note | One widget button per reason code of the pack, each with an optional note field |
| `require_reason` blocks the submit | `require_reason` holds the *capture*, never the send: a changed reply is posted to Overturn the moment the agent clicks why; until then the widget says `Changed · pick why below to save it` |
| Overturn failing never blocks the send | Gorgias has already sent the reply when the handler runs. Every failure still answers 200 with a status line (`Overturn could not save this correction (503). The reply was sent.`), so Gorgias never retries into a duplicate |

An exchange is captured once: only when the agent's reply is the newest message on the ticket (the event that woke the handler). Later messages on the ticket only refresh the widget. A recorded run pairs only with a reply sent after the run started, and runs that `/v1/capture` itself synthesized (tagged `capture:*`) are never mistaken for drafts.

## Install

1. In Overturn, create a project API key (Settings → API keys). In Gorgias, create a REST API key (Settings → REST API) for a user that can read tickets.
2. Build: `pnpm --filter @overturn-ai/gorgias-app build` gives you `dist/overturn-gorgias-app.zip` (`dist/app/`).
3. Deploy `server.js` anywhere with HTTPS (Railway, Fly, a container: `PORT=8787 node server.js`), or `handler.js` as a fetch handler (`createHandler(env)`). Environment:
   - `OVERTURN_API_KEY`: the project key
   - `WEBHOOK_SECRET`: any long random string; Gorgias sends it as `X-Overturn-Secret`
   - `GORGIAS_DOMAIN` (`acme` for acme.gorgias.com), `GORGIAS_USER` (the API user's email), `GORGIAS_API_KEY`
   - optional: `AGENT` (workflow name, one regression suite per workflow; default `support-reply`), `REASON_PACK` (`support` default, or `claims`), `REQUIRE_REASON` (default `true`), `DRAFT_MARKER` (default `[AI draft]`), `DRAFT_AUTHORS` (comma-separated emails of the drafting AI's Gorgias users), `MIN_DRAFT_CHARS` (default 80), `SCOPE_TAG` (only tickets with this tag are captured), `OVERTURN_BASE_URL` (self-hosting)
4. In `dist/app/gorgias/`, replace `https://YOUR-HANDLER-HOST` and `YOUR_WEBHOOK_SECRET` in `integration.json` and `widget.support.json` (or `widget.claims.json`), then create them:

   ```bash
   G=https://acme.gorgias.com/api; A="api@acme.com:$GORGIAS_API_KEY"
   ID=$(curl -s -u "$A" -H 'content-type: application/json' -d @integration.json $G/integrations | jq .id)
   jq --argjson id "$ID" '. + {integration_id: $id}' widget.support.json \
     | curl -s -u "$A" -H 'content-type: application/json' -d @- $G/widgets
   ```

5. Open a ticket, and drag the Overturn widget into the sidebar if Gorgias did not place it.

Out of scope: Gorgias's own stats, per-agent rates, and tickets with no draft (nothing is sent to Overturn for them; a ticket outside `SCOPE_TAG` is never read beyond its tags).

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/gorgias-app test      # payload builder, draft pairing, handler with Gorgias and Overturn mocked
pnpm --filter @overturn-ai/gorgias-app build
```

`src/capture.ts` is the logic (pure, tested); `src/handler.ts` is the Gorgias and Overturn glue; `src/setup.ts` builds the integration and widget JSON; `src/server.ts` is the Node entry.
