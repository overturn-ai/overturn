# Overturn Intercom Canvas Kit inbox app

Canvas Kit is a **server-side webhook protocol**. It renders in Inbox conversation details, not the reply composer. Its initialize/submit requests contain the conversation and app inputs, **not composer changes or native send events**. Consequently, automatic detection of Fin insertion and capture on native send require a separate, trusted integration that can observe those events; this package does not claim Canvas Kit alone can observe them. Never label a paste or long text jump `draft:ai`.

## Run

Build with `pnpm --filter @overturn-ai/intercom-app build`, then run `node dist/main.js` (or extract `dist/overturn-intercom-app.zip` and run `node main.js`). Node 20+. HTTPS reverse proxy required for Intercom. Environment:

- `OVERTURN_API_KEY`: server-only project key; never expose it in a Canvas.
- `INTERCOM_CLIENT_SECRET`: Intercom app client secret, used to verify `X-Body-Signature` HMAC-SHA256 of the raw Canvas request.
- `INTERCOM_BRIDGE_TOKEN`: separate strong bearer token for the trusted composer/send integration.
- `PORT`: server port (default 3000).
- `OVERTURN_BASE_URL`, `OVERTURN_AGENT`, `REASON_PACK` (`support` default or `claims`), `REQUIRE_REASON` (`true` default, `false` to disable).

Configure an Intercom Developer Hub app → Canvas Kit → **For teammates** → conversation details Inbox: initialize URL `https://YOUR_HOST/canvas/initialize`; submit URL `https://YOUR_HOST/canvas/submit`. Do not publish `/bridge/*` publicly without an authenticated private transport. State is in memory and scoped to this process; for multi-replica deployment use sticky routing or replace the map with a shared durable store.

## Bridge contract

A trusted integration must POST authenticated JSON (`Authorization: Bearer <INTERCOM_BRIDGE_TOKEN>`) to:

- `/bridge/draft` when it has *observed* a composer draft: `{ "conversation": { "id": "123", "subject": "Question", "url": "https://...", "messages": [{ "role": "customer", "content": "Hello", "author": "customer@example.com", "at": "2026-01-01T00:00:00Z" }] }, "text": "AI suggestion", "origin": "fin_assist", "at": 1767225600000 }`. Use `origin: "human_typed"` only with explicit typing evidence; all other values yield `draft:unknown`. Optional `fields`, `runId`, `model`.
- `/bridge/sent` **after** native send succeeds, with the same `conversation` shape (thread as it was *before* the reply), final `text`, optional `fields`, `actor`, `at`. The reply is never blocked by capture. POST failures return `{ok:true,status:"capture-failed"}` so the bridge can retry.

The Canvas reason picker saves `reason_code` and optional `reason_note` for that conversation. With `REQUIRE_REASON=true`, an edited reply without a code is held as a **pending capture**, not a pending send; saving the reason captures it automatically. Native send has already happened and cannot be held by Canvas Kit. On Overturn failure, the bridge may retry `/bridge/sent`. Canvas POST requests are signature-checked; bridge calls require the bearer token. The bridge must independently validate and authorize the incoming Intercom events and ensure send events are deduplicated upstream; the app is not an Intercom webhook subscriber.
