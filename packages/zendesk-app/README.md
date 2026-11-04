# Overturn for Zendesk

QA for AI-drafted replies, in the ticket sidebar. It watches the reply box for the AI draft, diffs it against what the agent actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: Zendesk's AI agents, a Salesforce bot, a homegrown drafter or a macro. The support lead gets the untouched rate and the fixes by reason, by team and by week, on the Capture page.

## What the agent sees

A small panel in the ticket sidebar:

- **Draft inserted · 112 words** once an AI assist, macro or paste lands in the reply box (anything reply-sized inserted in one go). If the drafting agent recorded its run with the Overturn SDK (`externalId: "zd:<ticket id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- A **reason** box with quick picks (wrong coverage decision, wrong amount or date, missing required step, tone / wording, policy exception).
- On **Submit**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. With *require a reason* on, a changed reply cannot be submitted without one.

Overturn failing never blocks the agent's work; the panel says what happened.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/zendesk-app build` → `dist/overturn-zendesk-app.zip`.
3. Zendesk Admin Center → Apps and integrations → Zendesk Support apps → **Upload private app** → the zip.
4. Settings:
   - `overturn_api_key` (secure; Zendesk keeps it server-side and signs the requests)
   - `agent`: the workflow name, one regression suite per workflow (default `claims-reply`)
   - `decision_fields`: custom fields that *are* the decision, as `id:label` pairs, e.g. `custom_field_123:status, custom_field_456:reserve`. Changes to these are scored exactly; the prose is scored by the judge.
   - `require_reason`, `capture_internal_notes`, `min_draft_chars`, `overturn_base_url` (self-hosting; add the host to `domainWhitelist` in `manifest.json`).

Or with `zcli`: `zcli apps:create dist/app`.

## Replay what it captured

```bash
overturn cases list --agent claims-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent claims-reply
```

## Development

```bash
pnpm --filter @overturn-ai/zendesk-app test      # draft detection, diff, send decision
pnpm --filter @overturn-ai/zendesk-app build
```

`src/capture.ts` is the logic (pure, tested); `src/main.ts` is the ZAF glue; `app/` is the manifest, iframe and translations.

## Marketplace listing

The app ships today as a private app (`"private": true`, uploaded per account). The marketplace submission uses the same zip with `"private": false` and the listing copy in [`docs/zendesk-marketplace.md`](../../docs/zendesk-marketplace.md); submission goes through the Zendesk partner account.
