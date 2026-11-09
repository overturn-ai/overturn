---
title: Privacy
description: What the hosted Overturn stores, where, for how long, who processes it, and how to delete it.
---

*Last updated 9 November 2026.*

This covers the hosted service at app.overturn.run and api.overturn.run. None of it applies when you [self-host](/docs/self-hosting/): then the data stays on your Postgres.

**What we store.** Your email address, to sign you in and invite you to workspaces. API keys, hashed. The runs your SDK or exporter sends: prompts, model responses, tool calls and their results, run input and output, tags. Captures from your help desk (the Zendesk app or `POST /v1/capture`): the ticket thread the reviewer saw, the AI draft, the reply they sent, the reason they picked, the reviewer name you configure, the ticket link, the requester's email or name, and how long the draft sat before it was sent. Corrections, cases and replay results. Project settings, including any Slack webhook URL you add.

We store what you send. Use the SDK's `redact` hook to drop or edit anything that should never leave your systems, and scope the Zendesk app to a tag if only some tickets should be captured.

**What we use it for.** Showing it back to your workspace, running the replays and training jobs you start, and operating the service. We do not sell it, we do not train models on it, and we do not use your content for anything else.

**Model calls.** Replays, the semantic scorer and training call the model providers you choose (OpenAI, Anthropic, Google, OpenRouter, Together) with the prompts in your cases; those providers' terms apply to those calls. Turn off **Settings → Privacy → hosted model calls** and the hosted service makes no model calls for that project; replays then run only against models you host.

**Who processes it.** Railway (hosting and database, US). Resend (sign-in and invitation email). PostHog (product analytics, US): page views, the funnel events listed in our repo, and session recordings with all text and inputs masked, so no ticket, prompt or model content reaches PostHog. Sentry (error reports, US): stack traces and request metadata, not your content; Sentry's session replay is off. The model providers above, only for calls you start.

**Cookies.** A session cookie on app.overturn.run, and PostHog's first-party cookie and local storage for product analytics. The marketing site and docs set none.

**How long.** Runs not behind a case are deleted after the project's retention setting (default 90 days). Runs behind a case, and cases, corrections, captures and replay results, are kept until you delete them or the workspace. Sign-in links expire in 15 minutes, sessions in 30 days.

**Who can see it.** Members of your workspace. The maintainers can reach the database to run the service and look at your content only to fix a problem you report, with your permission.

**Deleting.** Archive or delete cases and revoke keys in the app. To delete a workspace and everything in it, email shireen@overturn.run from a workspace member's address; we delete within 7 days and confirm. A data processing addendum is available on request.

**Security incidents.** If your data is exposed we tell workspace members by email within 72 hours of finding out.

**Changes.** Posted here; material changes are emailed to workspace members before they take effect.
