# Overturn for Gorgias

Captures what the AI drafted, what the agent sent, and one line on why, from inside Gorgias —
the same shape as `packages/zendesk-app`, on the Gorgias side of the product.

Every capture is a replayable case: what the model produced, what the expert changed it to,
and the reason, stored as a correction record that the suite replays before the next model or
prompt change.

## What it does

1. **Finds the draft** — a drafting agent that recorded its run with the Overturn SDK for this
   ticket (`externalId: "gr:<ticket id>"`). That run is the evidence that an assist, not the
   agent, wrote the draft.
2. **Offers the reason picker** (`reason_pack`: the vendor-neutral support pack by default)
   with an optional note. Each code is a row of the sidebar card, and a click captures.
3. **On send, POSTs `/v1/capture`** with `source: "gorgias"`, `externalId:
   "gr:<ticket id>"`, the ticket thread as `context`, and `draft` / `sent` as
   `{ text, fields? }`.
4. **Honours `require_reason`**: a changed reply is held until there is a reason.
5. **Never blocks the send** — the capture happens after the reply went out, and a failed
   capture is swallowed.

## What Gorgias does and does not give an app

Gorgias has no sidebar iframe like Zendesk's App Framework, and no endpoint for the unsent
reply box: `GET /api/tickets/{id}/messages` lists messages after they were sent. So this
package is an **HTTP integration plus a declarative widget**, not a browser bundle:

| | Endpoint | What it does |
| --- | --- | --- |
| Integration | `POST /gorgias/events` | Gorgias calls it on `ticket-created`, `ticket-message-created` and `ticket-updated`; the answer is what the card shows |
| Widget | `GET /gorgias/widget` | the same card, on demand |
| Reason | `GET /gorgias/reason` | a click on a reason code captures with it; without a code it serves the small form for a note |
| Reason | `POST /gorgias/reason` | the form posts the code and the note |

The widget is a [declarative template](https://developers.gorgias.com/reference/the-widget-object):
each field has a `path` that points into the integration's JSON answer, and each row of the
reason list is a card whose title is a link (`meta.link`). That is how one click captures.

## The draft origin

The tag follows what we were actually told, never a guess:

| What we know | Tag | The scorecard reads |
| --- | --- | --- |
| An assist recorded the run | `draft:recorded` | ai |
| The agent wrote it | `draft:manual` | manual |
| We were not told | *(no tag)* | unknown |

## Two things worth knowing before merging

**The capture is written after the reply went out.** Gorgias gives an app no submit hook, so
the app cannot veto a reply and does not pretend to. `require_reason` holds the *capture*,
not the reply: the card asks for the reason after the fact, and the correction joins the suite
once the agent clicks a code.

**The API did not know about Gorgias yet.** `packages/shared` `captureSourceSchema` did not
accept `"gorgias"`, so the API would have answered 400 on the payload. The enum gains
`"gorgias"` in this PR.

## The order context

Gorgias keeps the shop orders under the customer (`customer.integrations.<shop>.orders`), so
the newest order of the customer is the one the reply is about. It rides along in
`metadata.order` (`id`, `provider`, `total`, `currency`, `item_count`): an e-commerce
team's decision is about the order, not about the prose.

## Installing it

The app serves three routes and needs two credentials:

```sh
export GORGIAS_BASE_URL="https://your-shop.gorgias.com/api"
export GORGIAS_API_USER="admin@your-shop.com"
export GORGIAS_API_KEY="…"
export OVERTURN_APP_BASE_URL="https://overturn-gorgias.example.com"
export OVERTURN_API_KEY="…"
export OVERTURN_AGENT="support-reply"
node dist/index.js --install
```

That registers the HTTP integration (`POST /api/integrations`) and the ticket widget
(`POST /api/widgets`). The widget template that ships in the package is
`app/widget.json`; the install reads the same template the app answers with, and a unit test
keeps the two in step.

## How to verify

No new dependency: the package needs `@overturn-ai/shared` and nothing else. The unit tests
cover the payload builder, the widget template and the routes end to end against fakes; a
live Gorgias account is not needed — the Overturn and Gorgias clients are mocked the way the
Zendesk tests mock the ZAF client.

```sh
pnpm --filter @overturn-ai/gorgias-app typecheck
pnpm --filter @overturn-ai/gorgias-app test
pnpm --filter @overturn-ai/gorgias-app build   # dist/overturn-gorgias-app.zip
```

## Risk and rollback

Low and additive: a new package, no new dependency, and one enum value in
`packages/shared`. Nothing imports it yet, so deleting `packages/gorgias-app` and the enum
value is a complete rollback. The app only ever calls `GET /v1/runs`, `POST /v1/capture`,
`GET /api/tickets/{id}` and `GET /api/tickets/{id}/messages`, on the same host as the other
adapters.
