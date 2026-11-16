# Overturn for Front

This sidebar plugin records an AI draft, the reply a teammate actually sent, and the reason for an edit. It uses Front's documented `contextUpdates`, `fetchDraft`, and `listMessages` methods. The pure payload builder and draft detector live in `src/capture.ts`; the Front and DOM code lives in `src/main.ts`.

## Build and host

```bash
pnpm --filter @overturn-ai/front-plugin test
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build
```

The build produces `dist/overturn-front-plugin.zip`. Unzip it on an HTTPS host and run the included `server.mjs` with `OVERTURN_API_KEY` and `FRONT_PLUGIN_SECRET` in the host's environment. `OVERTURN_API_URL` defaults to `https://api.overturn.run`; `PORT` defaults to 3000. The server checks Front's `auth_secret` on the plugin URL, sets an HttpOnly session cookie, and forwards `/capture` to Overturn with the key kept server side. Keep the host behind HTTPS so the Secure cookie works. No key goes in `config.js` or the zip.

In Front Developers, create an app with a **Sidebar Plugin** feature. Set its URL to the hosted plugin root and set `FRONT_PLUGIN_SECRET` on the host to that feature's Auth secret. Configure `plugin/config.js` before building: `agent`, `reasonPack` (`support` or `claims`), `requireReason`, and `minDraftChars`. The sidebar only reads a conversation after a reply-sized draft appears or the teammate marks the current draft by hand. It captures the first new outbound message after that draft and uses the earlier messages as context.

Front's Plugin SDK does not document a send event or a way to veto Front's native Send button. The plugin therefore cannot block a changed send when `requireReason` is on. It holds **the capture** until a reason is chosen, even if the message was already sent. Capture failure is shown in the sidebar and never affects the Front send. For an enforceable pre-send reason, Front would need to expose a send interception hook or the team would need a controlled send flow through Front's Core API.

The Front SDK UMD URL in `plugin/index.html` follows Front's [installation reference](https://dev.frontapp.com/reference/installation). Front also documents the [context](https://dev.frontapp.com/reference/plugin-sdk-context), [draft](https://dev.frontapp.com/reference/plugin-sdk-draft), [message](https://dev.frontapp.com/reference/plugin-sdk-message), and [plugin auth secret](https://dev.frontapp.com/docs/security).
