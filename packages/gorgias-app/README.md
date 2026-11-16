# @overturn-ai/gorgias-app

Overturn capture adapter for [Gorgias](https://www.gorgias.com) (ticket sidebar widget).

Records what the AI drafted, what the agent sent, and a one-line reason (`POST /v1/capture` with `source: "gorgias"` and `externalId: "gr:<ticket id>"`), using the `support` reason pack by default and capturing ecommerce order-context fields.

## Scripts

```bash
pnpm --filter @overturn-ai/gorgias-app test
pnpm --filter @overturn-ai/gorgias-app typecheck
pnpm --filter @overturn-ai/gorgias-app build
```
