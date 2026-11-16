# Overturn for Intercom

QA for AI-drafted replies in Intercom Inbox. Overturn for Intercom uses Intercom's Canvas Kit (Inbox Conversation Details surface) to record what the AI drafted (Fin AI agent, Copilot assist, macro), what the human sent, and why, as a replayable case.

The drafting agent never has to be instrumented. The support lead gets the untouched rate and the fixes by reason, by team, and by week on the Capture page.

## What the teammate sees

In the Intercom Inbox Conversation Details sidebar:

- **Draft inserted · N words** once an AI assist, macro, or paste lands in the composer.
- A **reason** picker with quick-pick codes (`support` pack by default, or `claims` pack) and an optional note.
- On **Send**:
  - Sent as drafted → an `approve` capture (`changed: false`).
  - Changed → an `edit` capture (`changed: true`) carrying the reason code and note, saving the difference as a regression case.
- **Distinguishable draft origins**:
  - `draft:ai` tagged only when the draft came from an assist (Fin, AI assist).
  - `draft:manual` tagged when the teammate marked or typed the draft by hand.
  - No origin guessed when unknown.
- **Honours `require_reason`**: with `require_reason` enabled, changing a reply prompts for a reason code before recording the case.
- **Never blocks the send**: Overturn failing or network issues will never prevent a teammate from sending their reply.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build the package:
   ```bash
   pnpm --filter @overturn-ai/intercom-app build
   ```
   This produces `dist/overturn-intercom-app.zip`.
3. In the Intercom Developer Hub, configure your app with Canvas Kit for **Inbox (Conversation Details)**.
4. Settings:
   - `overturn_api_key`: your Overturn project API key.
   - `reason_pack`: `support` (default) or `claims`.
   - `agent`: workflow name (default `support-reply`).
   - `require_reason`: require a reason code when the reply is edited (default `true`).
   - `capture_internal_notes`: whether to capture internal notes in addition to public replies.
   - `decision_fields`: custom attributes scored exactly (e.g. `coverage:coverage, reserve:reserve`).
   - `scope_tag`: optional tag to restrict which conversations are watched.
   - `min_draft_chars`: minimum length for a draft insertion (default `80`).

## Development

```bash
pnpm --filter @overturn-ai/intercom-app test       # run unit tests
pnpm --filter @overturn-ai/intercom-app typecheck  # verify TypeScript strictness
pnpm --filter @overturn-ai/intercom-app build      # build bundle and zip
```
