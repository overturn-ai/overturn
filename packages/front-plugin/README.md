# Overturn for Front

QA for AI-drafted replies, embedded directly in Front. It watches the composer for an AI draft, diffs it against what the teammate actually sends, asks for a one-line reason, and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the correction becomes a case, and the regression suite replays it against any model before the next prompt or model change. The drafting agent never has to be instrumented, and it does not matter who wrote the draft: Front's AI answers, an external assist bot, a homegrown drafter, or a macro.

## What the teammate sees

A panel in Front's sidebar or composer toolbar:

- **Draft inserted · N words** once an AI assist, macro, or paste lands in the reply box (anything reply-sized inserted in one change). If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- A **reason** picker with quick-pick chips (`reason_pack`: `support` by default, or `claims` with the claims pack's eight codes) and an optional note.
- On **Send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case title and judge's rubric. With `require_reason` enabled, a changed reply is blocked until a reason is chosen.

Overturn failing never blocks the teammate's send; the panel logs and gets out of the way.

## Build

```bash
pnpm --filter @overturn-ai/front-plugin build
```

Assembles `dist/overturn-front-plugin.zip` containing the bundled script, HTML, manifest, and styles.

## Settings

- `overturn_api_key`: project API key from Overturn (Settings → API keys).
- `overturn_base_url`: Overturn API URL when self-hosting (default: `https://api.overturn.run`).
- `agent`: workflow name, one regression suite per workflow (default `support-reply`).
- `reason_pack`: `support` (default) or `claims`.
- `require_reason`: block changed replies until a reason is picked (default `true`).
- `capture_internal_notes`: also capture internal comments/notes (default `false`).
- `decision_fields`: custom fields that *are* the decision, e.g. `coverage:status, reserve:Reserve`.
- `min_draft_chars`: minimum characters for inserted text to count as draft (default `80`).
- `scope_tag`: optional tag to watch only conversations carrying this tag.

## Testing

```bash
pnpm --filter @overturn-ai/front-plugin test
```
