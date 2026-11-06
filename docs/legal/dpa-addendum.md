# Data Processing Addendum — Overturn hosted service (draft for counsel)

Draft. Not yet reviewed by a lawyer; do not send to a customer until it is. It exists so the hosted-training switch (`docs/decisions.md`, 2026-11-04) has something to be "after".

**Parties.** Overturn (Processor), operated by [legal entity, address]; the Customer (Controller) named in the order form.

**1. Scope.** This addendum governs Personal Data in ticket content, AI drafts, sent replies, reasons and reviewer identifiers that the Customer sends to the hosted service at app.overturn.run / api.overturn.run. It does not apply to self-hosted deployments, where Overturn processes nothing.

**2. Nature and purpose.** Storing the record of AI drafts and human corrections; computing team-level quality statistics; replaying corrections against models the Customer chooses; and, only where the Customer enables it in Settings, exporting corrections to train a model for that Customer alone.

**3. Instructions.** Overturn processes Personal Data only on the Customer's documented instructions, which are: the product's settings and API calls. Turning *hosted model calls* off in Settings is an instruction that no content leaves Overturn's infrastructure for a model vendor.

**4. Sub-processors.** Railway (hosting, US); the model vendors the Customer selects per replay (OpenAI, Anthropic, Google, OpenRouter, Together), each only when the Customer sends a request naming that vendor; Google Workspace (support email). Overturn gives 30 days' notice before adding a sub-processor; the Customer may object and terminate.

**5. No pooling.** Customer content is never used to train, evaluate or improve any model or service for anyone other than that Customer. Fine-tunes trained on a Customer's corrections are that Customer's, served to that Customer only, and deleted on request.

**6. Security.** Encryption in transit (TLS 1.2+) and at rest; per-project API keys; redaction presets applied at export; access limited to Overturn personnel with a support need, logged. A SOC 2 Type I report is targeted for [date]; the readiness checklist is `docs/soc2-readiness.md`.

**7. Protected health information.** The hosted service is not offered for PHI and no BAA is available. Customers with PHI self-host.

**8. Retention and deletion.** Raw runs are purged on the Customer's retention schedule (default 30 days); corrections and cases are kept until the Customer deletes them or the project. Deleting a project deletes everything under it within 30 days, backups included within 90.

**9. Data subject requests, breach notice, audits.** Overturn assists with access and deletion requests within 10 business days; notifies the Customer of a Personal Data breach without undue delay and within 72 hours of confirmation; makes available the SOC 2 report when it exists and, failing that, answers a reasonable security questionnaire once a year.

**10. Transfers.** Data is stored in the United States. For EU/UK customers the SCCs / UK Addendum are incorporated by reference [counsel: attach module 2].

**11. Order of precedence.** This addendum prevails over the Terms (`apps/docs/src/content/docs/terms.md`) for Personal Data.

Signature blocks.
