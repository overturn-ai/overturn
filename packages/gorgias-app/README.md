# Overturn for Gorgias

QA for AI-drafted replies, in the ticket sidebar. It finds the reply an assist drafted, diffs it against what the agent actually sent, asks for a one-click reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: a Gorgias AI assist, a macro, a homegrown drafter, or an agent pasting from a doc.

## What the agent sees

A small panel in the sidebar:

- **Draft inserted · 112 words** once a drafting agent recorded its run for this ticket with the Overturn SDK (`externalId: "gr:<ticket id>"`). "Use the newest reply as the draft" marks one by hand.
- A **reason** box with quick picks, and an optional note.
- **Capture this send** records the send: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. With *require a reason* on, a changed reply cannot be captured without one.

Overturn failing never blocks the agent's work; the panel says what happened.

## No composer API, and what that means

Gorgias gives an app no endpoint for the unsent reply box and no hook that can veto a send: the REST API lists messages only *after* they were sent. So both halves are read through the API:

- the **draft** as the run a drafting agent recorded with the SDK for this ticket (`externalId: "gr:<ticket id>"`), or the newest agent message marked by hand;
- the **sent body** as the newest agent message in the thread newer than the draft — never the text the widget last saw.

`require_reason` therefore holds a changed reply's *capture* in the panel until a chip is clicked rather than pretending to block Gorgias's send: nothing unexplained reaches the suite, and the send itself is never blocked or delayed.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/gorgias-app build` → `dist/app` (and `dist/overturn-gorgias-app.zip` when `zip` is on the PATH).
3. In Gorgias, Settings → Integrations, add an HTTP integration that points at the hosted widget URL (or sideload `dist/app`), and configure:
   - `overturn_api_key` (the project key)
   - `gorgias_base_url`, `gorgias_username`, `gorgias_api_key` (the account's REST API host and credentials, from Settings → REST API)
   - `agent`: the workflow name, one regression suite per workflow (default `support-reply`)
   - `reason_pack`: `support` (default) or `claims`, the one-click reasons agents see
   - `decision_fields`: custom fields that *are* the decision, as `id:label` pairs
   - `require_reason`, `capture_internal_notes`, `min_draft_chars`, `scope_tag`, `overturn_base_url`

The widget reads its settings from the widget URL query parameters (and from `window.__OVERTURN_SETTINGS__`, which the tests inject).

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/gorgias-app test      # settings, timestamps, thread mapping, send decision, REST client
pnpm --filter @overturn-ai/gorgias-app build
```

`src/capture.ts` is the logic (pure, tested); `src/gorgias-client.ts` is the REST API glue; `src/main.ts` is the widget glue; `app/` is the HTML shell, stylesheet and widget definition. The payload builder and the send decision are the same shape as `packages/zendesk-app` and `packages/front-plugin`; only the surface differs.
