# Overturn for Front

QA for AI-drafted replies, in the Front conversation sidebar. It watches the composer for the AI draft, diffs it against the message the teammate actually sends, asks for a one-line reason, and posts the result to [`POST /v1/capture`](../../docs/capture.md) with `source: "front"` and `externalId: "fr:<conversation id>"`. It is the Front counterpart of [`packages/zendesk-app`](../zendesk-app) and reuses its logic: the draft detector, `decideOnSend` and `statusLine` are imported from there, not copied.

## What the teammate sees

A small panel in the sidebar of the open conversation:

- **Draft inserted · 112 words** once an AI assist, a snippet or a paste lands in the composer (anything reply-sized inserted in one go). If the drafting agent recorded its run with the Overturn SDK (`externalId: "fr:<conversation id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- The **reason** chips (`reason_pack`: the eight claims codes by default, or the support pack) and an optional note.
- On **Send**: sent as drafted → an `approve` capture; changed → an `edit` capture with the reason as the case's title and the judge's rubric.

Overturn failing never gets in the way: the reply is Front's to send, and a failed capture is logged in the console and shown in the panel.

## Front has no pre-send hook: how `require_reason` works here

Front's [Plugin SDK](https://dev.frontapp.com/reference/plugin-sdk-api) (`@frontapp/plugin-sdk` 1.12) lets a plugin read and edit drafts (`fetchDraft`, `updateDraft`, `createDraft`) and read the conversation (`listMessages`, `listComments`), and pushes changes through `contextUpdates`. It has **no send event and no way to veto or delay a send**. So, unlike the Zendesk app (whose `ticket.save` handler can reject the submit):

- **Before the send**, a changed reply with no reason picked shows *Changed from the draft · pick why before you send* in the panel. That is a prompt, not a lock: Front's Send button still works.
- **The send is inferred**: the draft closes (it leaves `conversation.draftId`, or `fetchDraft` returns nothing) and a new outbound message appears in `listMessages`. The plugin keeps looking for up to 60 s, so Front's *Undo send* window is covered. A draft that closes with no new message was discarded, and nothing is captured.
- **After the send**, a changed reply with `require_reason` on and no reason is **held** in the panel (*Sent · waiting for a reason*) and posted the moment a reason is picked. It is never posted without one. Held corrections are kept per conversation, so switching conversations does not mix them up; they live in the panel's memory, so closing Front before picking a reason drops that one capture.
- The captured `sent` text is the message Front actually sent, not the composer, so signatures or edits made in the last second are included exactly as the customer got them.

If Front adds a pre-send hook, `decideOnFrontSend` already returns `need-reason` at the right moment; only the glue in `src/main.ts` / `src/plugin.ts` would change.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/front-plugin build` → `dist/overturn-front-plugin.zip` (a static page: `index.html`, `main.js`, `style.css`). Host the unzipped folder on any HTTPS static host.
3. In Front: Settings → Company → Developers → **Create app**.
   - **Servers → Add server**: origin `https://api.overturn.run` (or your self-hosted URL), authentication **Bearer** (Overturn reads `Authorization: Bearer <key>`); open it again and put the Overturn key in *Local credentials*. Front attaches the key when the plugin calls `relayHttp`; the key never reaches the browser or the page's URL.
   - **Features → Add feature → Sidebar plugin**: the URL of the hosted page, plus settings as query parameters, and select the server above.
4. Settings (query parameters on the plugin URL, same names as the Zendesk app):
   - `reason_pack`: `claims` (default) or `support`
   - `agent`: the workflow name, one regression suite per workflow (default `claims-reply`, or `support-reply` with the support pack)
   - `require_reason` (default `true`), `min_draft_chars` (default `80`)
   - `decision_fields`: conversation custom fields that *are* the decision, as `name:label` pairs, e.g. `Coverage:coverage, Reserve:reserve`. Changes to these are scored exactly; the prose is scored by the judge.
   - `scope_tag`: only conversations with this tag are watched
   - `capture_internal_notes`: also send the conversation's comments as `note` context (off by default)
   - `overturn_base_url`: self-hosting (match the server's origin)

   Example: `https://plugins.example.com/overturn-front/?reason_pack=claims&decision_fields=Coverage:coverage`

## What it reads

Nothing in a conversation is read until a draft appears in its composer: before that the plugin only re-reads the open draft once a second (Front sends no update while the teammate types) and looks up a recorded run by `fr:<conversation id>`. After a draft appears it lists the conversation's messages (to know which one the send creates), and on send the thread becomes the capture's `context`: inbound messages as `customer`, outbound as `agent`, comments as `note` when enabled.

## Development

```bash
pnpm --filter @overturn-ai/front-plugin test       # payload builder + the glue against a mocked Front SDK
pnpm --filter @overturn-ai/front-plugin typecheck
pnpm --filter @overturn-ai/front-plugin build
```

- `src/capture.ts`: pure logic. Maps a Front conversation onto the Zendesk app's snapshot, reuses its `decideOnSend`, and renames the payload for Front (`decideOnFrontSend`). Tested in `capture.test.ts`, including that the body passes `captureCreateSchema`.
- `src/plugin.ts`: the send / hold / post controller, written against a narrow `FrontSdk` interface. Tested in `plugin.test.ts` with a mocked SDK: draft detection, approve and edit captures, the held reason, fail-open, Undo send, discarded drafts, recorded runs, and conversation isolation.
- `src/main.ts`: the DOM panel and the real `@frontapp/plugin-sdk` wiring.
- `app/`: the HTML shell and stylesheet.
