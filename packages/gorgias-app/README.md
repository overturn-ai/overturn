# Overturn for Gorgias

QA for AI-drafted replies, in the Gorgias ticket sidebar widget. It watches the reply box for the AI draft, diffs it against what the agent actually sends, asks for a one-line reason (with one-click ecommerce support reason chips), and posts the result to `POST /v1/capture`. The draft becomes a recorded run, the difference becomes a case, and the suite replays it against any model before the next prompt or model change.

Gorgias ecommerce teams are the primary users: the app captures ticket context, message thread history, and order-context fields (`order_number`, `fulfillment_status`, `financial_status`, `tracking_number`, `refund_amount`, `return_status`) alongside the drafted and sent response.

## What the agent sees

A clean panel in the Gorgias ticket sidebar:

- **Draft inserted · N words** once an AI assist, macro or paste lands in the reply box (anything reply-sized inserted in one go). If the drafting agent recorded its run with the Overturn SDK (`externalId: "gr:<ticket id>"`), the draft is taken from that run instead. "Use the current text as the draft" marks it by hand.
- An **order badge** displaying active order context (`order_number` / `order_id`).
- A **reason** picker with quick picks for support (`wrong_answer`, `missing_information`, `wrong_amount_or_date`, `missing_required_step`, `against_policy`, `should_escalate`, `tone_wording`, `wrong_language_or_format`) plus an optional note.
- On **Send**: sent as drafted → an `approve` capture, no prompt; changed → an `edit` capture with the reason as the case's title and the judge's rubric. With *require a reason* on, agents are prompted when modifying a draft.
- **Never blocks the send**: Overturn captures asynchronously and never interrupts or prevents the agent from sending a response in Gorgias.

## Install

1. In Overturn, create a project API key (Settings → API keys).
2. Build: `pnpm --filter @overturn-ai/gorgias-app build` → `dist/overturn-gorgias-app.zip`.
3. Gorgias Settings → Apps & Integrations → HTTP Integration / Sidebar Widget → Upload app zip or configure widget URL with `dist/app/assets/iframe.html`.
4. Settings:
   - `overturn_api_key`: Overturn project API key
   - `reason_pack`: `support` (default) or `claims`
   - `agent`: the workflow name (default `support-reply`)
   - `decision_fields`: custom fields that *are* the decision, as `id:label` pairs
   - `order_fields`: comma-separated order fields (default: `order_id,order_number,fulfillment_status,financial_status,tracking_number,refund_amount,return_status`)
   - `require_reason`, `capture_internal_notes`, `min_draft_chars`, `overturn_base_url`

## Development

```bash
pnpm --filter @overturn-ai/gorgias-app test      # payload builder, draft detection, order fields, diff
pnpm --filter @overturn-ai/gorgias-app typecheck # strict typescript checks
pnpm --filter @overturn-ai/gorgias-app build     # tsup bundle and zip artifact generation
```

- `src/capture.ts`: Pure, strictly-typed logic for Gorgias snapshot parsing, draft detection, order field extraction, and capture decision.
- `src/main.ts`: Widget iframe glue, event listening, and API capture client.
- `src/capture.test.ts`: Vitest unit test suite covering payload construction, ecommerce fields, reason packs, and diff handling.
- `app/`: Manifest, assets, CSS, and HTML template.
