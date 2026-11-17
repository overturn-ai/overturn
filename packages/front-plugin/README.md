# Overturn for Front

Capture the correction where it happens: what the AI drafted in the Front composer, what the
teammate sent instead, and one line on why. Each one is a replayable case for the workflow and
training data for the model the customer ends up owning. The same idea as
[`packages/zendesk-app`](../zendesk-app): Front, Salesforce Service Cloud and Gmail follow the
same shape.

## What it does

For a conversation the teammate is replying to:

- **Draft inserted · 112 words** when a reply-sized text lands in the composer (an AI assist, a
  rule, a paste). A drafting agent that recorded its run with the SDK
  (`externalId: "fr:<conversation id>"`) is picked up as the draft instead.
- **Reason** chips: the `reason_pack` (`claims` or `support`) with an optional note.
- On send, `POST /v1/capture` with `source: "front"`, `externalId: "fr:<conversation id>"`, the
  thread as `context`, and `draft` / `sent` as `{ text, fields? }`.

`require_reason` (default on) holds a **changed** reply until a chip is picked: the payload stays
in the panel and is posted the moment one is. Front exposes no hook that can stop its own send, so
the gate is on the capture, not on Front's send button. A capture that fails says so in the panel
and never blocks the teammate.

Nothing else is read: the thread is only loaded once a draft has appeared, and with `scope_tag`
set, a conversation without the tag is never read at all.

## Install

Front plugins are a page embedded in the conversation sidebar.

1. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/app/` (and
   `dist/overturn-front-plugin.zip`).
2. Host `dist/app/` over HTTPS (any static host; it is two files).
3. In Front: **Settings → Apps → Create app**, add a **plugin** feature, and use the hosted URL.
4. Settings ride on the plugin URL as query parameters. The first load stores the key in the
   browser and the panel asks for one if it is missing:

| parameter | default | meaning |
| --- | --- | --- |
| `api_key` | — | Overturn project API key (stored in the browser after the first load) |
| `overturn_base_url` | `https://api.overturn.run` | API base URL |
| `agent` | `support-reply` | the workflow one regression suite covers |
| `require_reason` | `true` | hold a changed reply until a reason is picked |
| `reason_pack` | `support` | `claims` or `support` chips |
| `scope_tag` | — | only watch conversations carrying this tag |
| `min_draft_chars` | `80` | shorter composer texts are not a draft |
| `capture_comments` | `true` | include internal comments as context notes |
| `decision_fields` | — | conversation custom fields that *are* the decision, e.g. `coverage,reserve` |

## How a send is read

Front has no send event: the composer context disappears and the conversation context comes back
with one more message. The panel therefore keeps the last non-empty draft, and when the composer
closes it lists the thread and matches a fresh `outbound` message against the draft
([`newlySent`](src/capture.ts)). A signature appended on the way out does not break the match; a
draft that was discarded matches nothing and is dropped. Two ambiguous fresh replies are skipped
rather than guessed.

## Develop

```bash
pnpm --filter @overturn-ai/front-plugin test
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build
```

The payload builder and the send matcher are pure and covered by unit tests; a live Front account
is not needed (the SDK surface is mocked the way the Zendesk tests mock the ZAF client).
