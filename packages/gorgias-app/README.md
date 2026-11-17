# @overturn-ai/gorgias-app

Overturn capture adapter for Gorgias (ticket sidebar widget).
Addresses [Issue #22: Bounty $100: capture adapter for Gorgias](https://github.com/overturn-ai/overturn/issues/22).

## Features
1. **Draft Detection**: Detects AI drafts or inserted responses in the Gorgias ticket reply box, updating widget status: `Draft inserted · N words`.
2. **E-Commerce Order Context**: Automatically captures Shopify/Magento order context (`order_id`, `order_number`, `order_total`, `fulfillment_status`, `tracking_number`) directly into decision fields for exact scoring.
3. **Reason Codes**: Provides vendor-neutral `support` codes by default with optional rationale notes.
4. **Standardized Overturn Payload**: Sends `POST /v1/capture` with `source: "gorgias"`, `externalId: "gr:<ticket id>"`.
5. **Non-blocking Execution**: Never blocks or delays agent sends. Validates `require_reason` when edits are detected.

## Test Suite
```bash
npm test
```
