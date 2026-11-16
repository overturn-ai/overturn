# Overturn for Intercom

QA for AI-drafted replies in Intercom (Canvas Kit, inbox surface). It detects when a draft lands in the composer, displays `Draft inserted · N words`, offers a reason picker (`support` codes by default) with an optional note, and posts `POST /v1/capture` with `source: "intercom"` and `externalId: "ic:<conversation id>"` on send—without ever blocking the send.

## Origin Tagging

Intercom's Fin assists and human-written replies remain strictly distinguishable:
- `draft:ai` — only when the draft came from an AI assist (`ai`) or SDK-recorded run (`recorded`).
- `draft:manual` — when the human typed or explicitly marked the draft (`manual`).
- `draft:unknown` — when the origin was not provided (`unknown`).

## Development

```bash
pnpm --filter @overturn-ai/intercom-app test
pnpm --filter @overturn-ai/intercom-app typecheck
pnpm --filter @overturn-ai/intercom-app build   # outputs dist/overturn-intercom-app.zip
```
