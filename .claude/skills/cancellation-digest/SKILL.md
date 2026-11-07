---
name: cancellation-digest
description: Every Monday, pull every Stripe cancellation and its reason from the past week into one doc. Use when the weekly task fires or when asked why customers churned.
---

# Cancellation digest

1. Stripe MCP: list subscriptions with `status=canceled` and `canceled_at` in the last 7 days; for each, `cancellation_details` (reason, feedback, comment), plan, MRR, tenure, customer email domain.
2. If the product has an in-app cancel survey, join on customer id.
3. One doc, `docs/wiki/churn/<week>.md`, and the same as a Claude doc if asked:
   - headline: count, MRR lost, vs previous week
   - table: customer (domain only), plan, tenure, Stripe reason, verbatim comment
   - clusters: group the comments; one line per cluster with count
   - the one thing to change this week, or "nothing actionable" with why
4. Anyone who cancelled with a comment gets a draft reply from Shireen in the writing-voice skill, saved to the doc, not sent.

Zero cancellations: two lines, stop.
