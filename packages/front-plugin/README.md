# Overturn for Front

QA for AI-drafted replies, inside Front. It watches the composer for the AI draft, diffs it against what the agent actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: an AI sidebar, a macro, or a paste. The support lead gets the untouched rate and the fixes by reason, by team and by week, on the Capture page.

Same shape as the [Zendesk app](../zendesk-app): `src/capture.ts` is the pure payload builder (draft detection, context mapping, the send decision), unit-tested with the Front SDK surface mocked; `src/main.ts` is the thin glue over `@frontapp/plugin-sdk`.

## What the agent sees

A small panel in the composer (or the conversation sidebar):

- **Draft inserted · 112 words** once an AI assist, macro or paste lands in the reply box (anything reply-sized inserted in one go). If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- A **reason** box with quick picks from the installed pack: `support` (wrong answer, missing information, should have escalated...) by default, or the `claims` pack's eight codes (wrong coverage decision, missed exclusion, reserve too low...).
- On **send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric.

## One Front difference: nothing can block the send

Front's plugin SDK gives a plugin no send hook and no way to hold a reply, and a capture must never block the agent's work anyway. So the plugin detects the send as the sent message lands in the thread, and `require_reason` gates the **capture**, not the send: a changed reply with no reason picked is held in the panel — "Pick why you changed it above" — and posts the moment the agent clicks a reason. A failed capture is logged in the panel and gets out of the way.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip` (and the unzipped bundle in `dist/app`).
3. Host the bundle anywhere HTTPS (it is a static page plus one script).
4. In Front: Settings → Plugins → add a plugin pointing at the hosted `index.html`, placed in the composer (sidebar works too), with the settings below appended to the plugin URL as query parameters:
   - `overturn_api_key` (required) — the project API key; it is sent as the `Authorization: Bearer` header on `POST /v1/capture`
   - `reason_pack`: `support` (default) or `claims`, the one-click reasons agents see
   - `agent`: the workflow name, one regression suite per workflow (default `support-reply`; a claims team might use `claims-reply`)
   - `decision_fields`: conversation custom attributes that *are* the decision, as `attribute_name:label` pairs, e.g. `coverage:coverage, reserve_amount:reserve`. Changes to these are scored exactly; the prose is scored by the judge.
   - `require_reason`, `capture_internal_notes`, `min_draft_chars`, `scope_tag` (only conversations carrying this Front tag are watched), `overturn_base_url` (self-hosting).

## Replay what it captured

```bash
overturn cases list --agent claims-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent claims-reply
```

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test      # draft detection, diff, send decision
pnpm --filter @overturn-ai/front-plugin build
```
