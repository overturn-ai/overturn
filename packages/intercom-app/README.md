# Overturn for Intercom

QA for AI-drafted replies, inside Intercom. It watches the conversation for the AI draft, diffs it against what the agent actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The support lead gets the untouched rate and the fixes by reason, by team and by week, on the Capture page.

Same shape as the [Zendesk app](../zendesk-app): `src/capture.ts` is the pure payload builder (draft origin, context mapping, the send decision), unit-tested against the shared zod contract; `src/main.ts` is the Canvas Kit glue — framework-free `handleInitialize` / `handleSubmit` functions over the webhook payloads Intercom POSTs, so any host server can mount them.

## Fin drafts are not human drafts

The bounty spec is explicit that a Fin draft and a human-written reply must be distinguishable, and the shared contract scores by it (`draftOriginSchema`, derived from the capture's `draft:*` tags). So:

- A draft that came from an assist — Fin's part on the conversation, or a run the drafting agent recorded with the SDK — is tagged `draft:ai`.
- A draft the expert marked by hand in the canvas is tagged `draft:manual`.
- A draft whose origin nobody stated carries **no** `draft:*` tag, which the scorecard reads as `unknown`. Guessing an origin we were not told is worse than `unknown`, so the code never infers one: no typing detection, no heuristics — Canvas Kit has no composer feed to detect from anyway.

## What the agent sees

A small app in the conversation details panel (Canvas Kit, inbox surface):

- **Draft inserted · 112 words** when Fin's reply is the newest part on the conversation and is waiting for the expert. If the drafting agent recorded its run with the Overturn SDK (`externalId: "ic:<conversation id>"`), the host can pass that run's output as the draft instead. A draft can also be marked by hand: paste the drafted text into the canvas and it becomes the draft, tagged `draft:manual`.
- A **reason** picker with quick picks from the installed pack: `support` (wrong answer, missing information, should have escalated...) by default, or the `claims` pack's eight codes (wrong coverage decision, missed exclusion, reserve too low...), plus an optional note.
- **Save capture** once the reply has gone out: sent as drafted → an `approve` capture, no reason needed; changed → an `edit` capture with the reason as the case's title and the judge's rubric.

## Two Intercom differences, called out honestly

Canvas Kit is a request/response UI surface, not a composer plugin:

- **Nothing can block the send, and nothing here tries.** Canvas Kit gives an app no send hook. The expert sends in Intercom as usual; the app reads the sent reply off the thread (the newest teammate comment part after the draft) when the expert saves the capture. `require_reason` therefore gates the *capture*, not the send: a changed reply with no reason picked is held in the canvas — "Pick why you changed it" — and posts the moment a reason is chosen.
- **The handlers are stateless.** Canvas Kit state rides in the canvas `stored_data`, which is where the draft (text, origin, when it appeared) travels between the initialize and submit requests. The host server keeps nothing between calls.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/intercom-app build` → `dist/overturn-intercom-app.zip`.
3. Host the handlers behind HTTPS and mount them on two URLs: initialize and submit. The host owns the Overturn call — `handleSubmit` takes a `postCapture` dependency that POSTs the payload to `${overturn_base_url}/v1/capture` with the API key as a Bearer token.
4. In Intercom's Developer Hub: your app → Configure → Canvas Kit → **For teammates** → enable the conversation-details location, and set the Initialize and Submit flow webhook URLs to your endpoints.
5. Settings (same names and semantics as the Zendesk app), supplied by the host server's config and parsed by `settingsFrom`:
   - `overturn_base_url` (default `https://api.overturn.run`), `agent` (the workflow name, one regression suite per workflow, default `support-reply`)
   - `reason_pack`: `support` (default) or `claims`, the one-click reasons agents see
   - `decision_fields`: conversation custom attributes that *are* the decision, as `attribute:label` pairs, e.g. `coverage_amount:coverage, reserve_amount:reserve`. Changes to these are scored exactly; the prose is scored by the judge.
   - `require_reason`, `capture_internal_notes`, `min_draft_chars`, `scope_tag` (only conversations carrying this Intercom tag are watched)

## Replay what it captured

```bash
overturn cases list --agent claims-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent claims-reply
```

## Development

```bash
pnpm --filter @overturn-ai/intercom-app test      # payload builder, origin tagging, canvas flows
pnpm --filter @overturn-ai/intercom-app build
```
