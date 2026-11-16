# Overturn for Intercom

QA for AI-drafted replies, in the inbox. The app captures what Fin (or another assist) drafted, what the teammate actually sent, and one line on why, then posts it to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change.

It follows the Zendesk app's shape: `src/capture.ts` is the pure, tested payload builder; `src/app.ts` renders the Canvas Kit flow; `src/server.ts` is the HTTP glue.

## What the teammate sees

- **Draft inserted · 112 words** once a reply-sized draft is present.
- A **reason** picker with the installed pack's codes (`support` by default, `claims` when a claims team opts in) and an optional note.
- On **Capture this correction**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case title and the judge's rubric. With `require_reason` on, a changed capture waits for a reason code.

Overturn failing never blocks Intercom's send. The Canvas Kit handler always answers with a canvas; a failed capture is logged and shown as muted text.

## Draft origin is explicit, never guessed

The run is tagged `draft:ai` only when an assist flag, an explicit `draft.origin`, or the draft author type says an assist wrote it. A draft the teammate typed is `draft:manual`. If nobody said, the tag is `draft:unknown`; the scorecard never infers an origin from the reply text.

Canvas Kit does not expose the native composer to an app. The app accepts the current draft from `composer` (or `draft`) in the initialize request when a companion integration can supply it, and otherwise lets the teammate paste/mark the draft with an explicit origin. The final sent text can be supplied as `sent_text`; leaving it empty captures the draft as sent unchanged.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Deploy this package: `pnpm --filter @overturn-ai/intercom-app build`, then run `node dist/bin.js` (or deploy `dist/app`). `dist/overturn-intercom-app.zip` is the reviewable/deployable bundle.
3. Environment:
   - `OVERTURN_API_KEY` (required, server-side only)
   - `OVERTURN_AGENT`: the workflow name, one regression suite per workflow (default `support-reply`)
   - `OVERTURN_REASON_PACK`: `support` (default) or `claims`
   - `OVERTURN_REQUIRE_REASON`: `true` (default) or `false`
   - `OVERTURN_DECISION_FIELDS`: optional `key` or `key:Label` pairs, comma-separated
   - `OVERTURN_BASE_URL` for self-hosting (default `https://api.overturn.run`)
   - `INTERCOM_CLIENT_SECRET` to verify Intercom's `X-Body-Signature` header
   - `PORT`/`HOST` for the server
4. In the Intercom Developer Hub → Canvas Kit → **For teammates**, add **conversation details** and point:
   - Initialize flow: `https://YOUR_DEPLOYMENT/intercom/initialize`
   - Submit flow: `https://YOUR_DEPLOYMENT/intercom/submit`

`app/canvas-kit.json` records the same endpoint contract for deploy review.

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/intercom-app test      # draft detection, payload builder, canvas flow
pnpm --filter @overturn-ai/intercom-app typecheck
pnpm --filter @overturn-ai/intercom-app build     # dist/overturn-intercom-app.zip
```
