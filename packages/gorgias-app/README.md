# Overturn for Gorgias

Ticket-sidebar app that captures what the AI drafted, what the agent sent, and why, as a replayable Overturn case.

## Behavior
- Watches the Gorgias reply box for a draft-sized insert (`Draft inserted · N words`).
- Lets agents pick a reason (`reason_pack`, support by default) and optional note.
- On send, posts `POST /v1/capture` with `source: "gorgias"` and `externalId: "gr:<ticket id>"`.
- Honors `require_reason`; never blocks the send on Overturn/network failures.

## Development
```bash
pnpm --filter @overturn-ai/gorgias-app test
pnpm --filter @overturn-ai/gorgias-app build
```

Payout/claim note (if maintainer supports crypto): EVM/Base/Polygon/BEP20 `0xE4BECfd60D9917946292E0d535081Dd005117069`, Solana `2LAnF7EeCeGSeHn1Pvu8onnX9CiHAjJwAHBE1pXdYKbp`.
