# Facts: Overturn

What agents may state about Overturn in anything a customer, prospect or the public reads: email, texts, posts, site copy, replies. If a claim is not under Can say, do not make it. Leave it out or ask Shireen. Every line names where it comes from. Change this file by PR only.

Last reviewed: 2026-11-15. Drafted from what the repo already states; Shireen approves by merging.

This repo is public. Nothing here may name a customer, a design partner or a price.

## Can say
- Overturn is QA for AI-drafted replies. It records what the AI wrote, what the agent sent and why, inside the help desk, and runs every fix as a test before the next model or prompt change. (README.md)
- It works in Zendesk today. Salesforce Service Cloud is next and is not shipped. (README.md)
- Open source under Apache-2.0. Self-hosted on one Postgres. (README.md)
- Site overturn.run, docs docs.overturn.run, hosted app app.overturn.run. (README.md, CLAUDE.md)
- SDKs: `@overturn-ai/sdk` on npm and `overturn` on PyPI. CLI: `npx overturn`. (README.md)
- Neutral across vendors: it works whether Zendesk, Salesforce or your own agent wrote the draft. (README.md)
- Each correction becomes a regression case, scored on the decision fields of the answer and not its prose. (README.md)
- Insurance claims is the case study, not a requirement. The same loop runs for customer support, billing, field service and compliance review. (README.md)

## Cannot say
- Any count of customers, installs, corrections captured or revenue.
- Any customer or design-partner name, logo or quote.
- A price or a plan.
- That Salesforce, Front or any help desk other than Zendesk is supported today.
- A number for how much Overturn improves accuracy or cuts review time.
- That Overturn is better at evals than Braintrust, LangSmith, Langfuse or the others. We integrate and export; we do not compete on that.

## Not confirmed: do not say until Shireen moves it up
- Whether training a customer-owned model is available now or only planned.
- Which eval and observability tools Overturn exports to today.
- Whether the hosted app is open to anyone or invite only.
