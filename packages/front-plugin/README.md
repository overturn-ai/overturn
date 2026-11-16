# Overturn for Front

This sidebar plugin records an AI draft, the reply a teammate actually sent, and the reason for an edit. It uses Front's documented `contextUpdates`, `fetchDraft`, `listMessages`, and `listComments` methods. The pure payload builder and draft detector live in `src/capture.ts`; the per-conversation state machine lives in `src/controller.ts`; `src/main.ts` is only the DOM wiring.

## Build and host

```bash
pnpm --filter @overturn-ai/front-plugin test
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build
```

The build produces `dist/overturn-front-plugin.zip` (packed by `scripts/package.mjs` in Node — no system `zip` binary needed). Unzip it on an HTTPS host and run the included `server.mjs` with `OVERTURN_API_KEY` and `FRONT_PLUGIN_SECRET` in the host's environment. `OVERTURN_API_URL` defaults to `https://api.overturn.run`; `PORT` defaults to 3000. The server checks Front's `auth_secret` on the plugin URL, sets an HttpOnly session cookie, and forwards `/capture` to Overturn with the key kept server side. Keep the host behind HTTPS so the Secure cookie works. No key goes in `config.js` or the zip. The `/capture` endpoint only accepts same-origin `application/json` posts carrying the plugin's `X-Overturn-Capture` header, and the upstream call times out after 10 seconds, so a cross-site form post cannot ride the session cookie.

In Front Developers, create an app with a **Sidebar Plugin** feature. Set its URL to the hosted plugin root and set `FRONT_PLUGIN_SECRET` on the host to that feature's Auth secret. Configure `plugin/config.js` before building: `agent`, the reason pack, `requireReason`, and `minDraftChars`. The setting names from the capture spec — `reason_pack` (`support` or `claims`), `require_reason`, and `min_draft_chars` — are accepted alongside the camelCase spellings. The sidebar only reads a conversation after a reply-sized draft appears or the teammate marks the current draft by hand. It captures the first new outbound message after that draft and uses the earlier messages — plus internal comments, read with `listComments` and sent as notes — as context. State is tracked per conversation: switching away and back never mixes drafts, reasons, or notes between conversations.

## What require_reason means in Front

Front's Plugin SDK does not document a send event or a way to veto Front's native Send button, so no Front sidebar plugin can block a changed send when `require_reason` is on — that limit is the platform's, not this plugin's. What `require_reason` does here: the send goes out, and **the capture is held** — nothing is posted to Overturn — until the teammate picks a reason code (a note alone is not enough). Only then is the correction saved. Capture failure is shown in the sidebar and never affects the Front send. For an enforceable pre-send reason, Front would need to expose a send interception hook or the team would need a controlled send flow through Front's Core API.

## Implementation notes

- Direction is read from the SDK's message `status` field (`"inbound" | "outbound"`), the field the Plugin SDK actually defines.
- The Overturn API key never reaches the browser: the sidebar posts to the bundled `server.mjs`, which holds the key and forwards server side.
- The sent reply is never part of its own context: context is snapshotted when the draft appears, before the send.
- A sent message whose content Front has not loaded yet is held, not dropped: the plugin keeps polling until the body arrives, then captures it.

The Front SDK UMD URL in `plugin/index.html` follows Front's [installation reference](https://dev.frontapp.com/reference/installation). Front also documents the [context](https://dev.frontapp.com/reference/plugin-sdk-context), [draft](https://dev.frontapp.com/reference/plugin-sdk-draft), [message](https://dev.frontapp.com/reference/plugin-sdk-message), and [plugin auth secret](https://dev.frontapp.com/docs/security).
