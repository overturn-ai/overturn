# Overturn for Front

QA for AI-drafted replies, in the Front conversation sidebar. It watches the reply box for an AI draft, diffs it against what is sent, asks for a one-line reason, and posts the result to `POST /v1/capture` (`source: "front"`, `externalId: "fr:<conversation id>"`). The payload is documented in [docs/capture.md](../../docs/capture.md).

## What the agent sees

- **Draft inserted · N words** once a draft lands in the reply box (anything reply-sized inserted in one go). "Use the current text as the draft" marks it by hand.
- A **reason** picker (`reason_pack`: `support` by default, or the eight `claims` codes) and an optional note.
- When the reply goes out: sent as drafted is an `approve` capture, changed is an `edit` capture with the reason.

Nothing but the reply box is read until a draft exists; conversations without one are never loaded.

## Limits

Front's plugin API has no pre-send hook, so the plugin cannot block the send. With `require_reason` on (the default), a changed reply is held in the panel and captured as soon as a reason is picked. If Overturn fails, the failure is logged and shown in the panel; Front is never blocked. The plugin reads the open reply box from the context's `draft`; if a Front account does not expose it, use "Use the current text as the draft".

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip` (the folder is `dist/app`).
3. Host the folder over HTTPS and add its `index.html` as a plugin in Front (Settings → Developers → Plugins).
4. Open the plugin and fill in the setup form. Settings and the key are stored in the plugin origin's `localStorage`: `overturn_api_key`, `agent`, `reason_pack`, `require_reason`, `overturn_base_url`.

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test
pnpm --filter @overturn-ai/front-plugin build
```

`src/capture.ts` is the logic (pure, tested); `src/glue.ts` is the send/hold/post controller (tested with a mocked SDK view and `fetch`); `src/main.ts` is the Front SDK and DOM glue; `app/` is the sidebar page.
