# Overturn for Gorgias

QA for AI-drafted replies, inside Gorgias. It records what the AI drafted for a ticket, diffs it against what the agent actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change. The support lead gets the untouched rate and the fixes by reason, by team and by week, on the Capture page.

Same shape as the [Zendesk app](../zendesk-app): `src/capture.ts` is the pure payload builder (draft origin, context mapping, the send decision), unit-tested against the shared zod contract; `src/main.ts` is the glue — framework-free handlers over the Gorgias ticket payloads, so any host server can mount them.

**One shared change rides along:** `captureSourceSchema` in `packages/shared` gains `"gorgias"`. The issue spec names `source: "gorgias"`, and without the enum value the API's own validation would reject every capture this app posts. It is a one-line, additive change; the shared contract tests cover it.

## How a Gorgias app is shaped

Gorgias's app surface is not an iframe SDK: it is an **HTTP integration** (Gorgias calls your endpoint when a ticket is created, updated, or gets a new message) plus a **sidebar widget** that renders fields out of the JSON your endpoint answers with. This package ships both definitions (`app/integration.json`, `app/widget.json`) and the handlers behind the endpoint:

- The widget shows the draft state for the open ticket: **Draft inserted · 112 words** once a draft is recorded for it.
- On the **ticket-message-created** trigger, when the new message is the agent's public reply, the handler captures it against the recorded draft: sent as drafted → an `approve` capture; changed → an `edit` capture with the reason as the case's title and the judge's rubric.

## Where the draft comes from

Gorgias gives a third-party app no view into the reply box, so — like the send — the draft is recorded by someone who knows, never guessed:

- The AI drafting integration records its draft through the app's endpoint (`recordDraft`) and says where it came from. An assist's draft is tagged `draft:ai`; a run the drafting agent recorded with the Overturn SDK is found by `externalId: "gr:<ticket id>"` and also counts as `draft:ai`.
- A draft the expert marked by hand is tagged `draft:manual`.
- A draft whose origin nobody stated is stored as `unknown` and the capture carries **no** `draft:*` tag, which the scorecard reads as `unknown`. Guessing an origin we were not told is worse than `unknown`.

Ecommerce teams are the first users here, so the order context is a decision field, not prose: map the ticket's order fields (`order_status`, `refund_amount`, ...) through `decision_fields` and changes to them are scored exactly, while the reply text is scored by the judge.

## Nothing blocks the send

The send has already happened by the time Gorgias calls the endpoint — a capture cannot block it, and never should. `require_reason` therefore gates the *capture*: a changed reply with no reason picked is held (the draft stays recorded), and the capture completes when the host calls again with the reason the expert picked, e.g. from a macro action. A failed capture is logged by the host and gets out of the way.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/gorgias-app build` → `dist/overturn-gorgias-app.zip`.
3. Host the handlers behind HTTPS. The host owns the Overturn call — the handlers take a `postCapture` dependency that POSTs the payload to `${overturn_base_url}/v1/capture` with the API key as a Bearer token, plus a small draft store (one draft per ticket).
4. In Gorgias: create the HTTP integration from `app/integration.json` (Settings → Integrations, or `POST /api/integrations`), pointing at your endpoint, then create the widget from `app/widget.json` with the integration's id.
5. Settings (same names and semantics as the Zendesk app), supplied by the host server's config and parsed by `settingsFrom`:
   - `overturn_base_url` (default `https://api.overturn.run`), `agent` (the workflow name, one regression suite per workflow, default `support-reply`)
   - `reason_pack`: `support` (default here) or `claims`, the one-click reasons agents see
   - `decision_fields`: ticket fields that *are* the decision, as `id:label` pairs, e.g. `order_status:order_status, refund_amount:refund`. Changes to these are scored exactly; the prose is scored by the judge.
   - `require_reason`, `capture_internal_notes`, `min_draft_chars`, `scope_tag` (only tickets carrying this Gorgias tag are watched)

## Replay what it captured

```bash
overturn cases list --agent support-reply
overturn replay --model openai/gpt-4.1-mini,together/deepseek-ai/DeepSeek-V4.1-Flash --agent support-reply
```

## Development

```bash
pnpm --filter @overturn-ai/gorgias-app test      # payload builder, origin tagging, integration handlers
pnpm --filter @overturn-ai/gorgias-app build
```
