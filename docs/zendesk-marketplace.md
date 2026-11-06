# Zendesk Marketplace listing (prep)

Submission goes through the Zendesk partner account; this file is the copy to paste. The build emits two zips: `dist/overturn-zendesk-app.zip` (private upload) and `dist/overturn-zendesk-app-marketplace.zip` (same app, `"private": false`); both are attached to every GitHub release. Submit the marketplace zip.

**Steps (partner account, ~20 min):** 1) developer.zendesk.com → sign in with shireen@overturn.run → Apps → Marketplace → *Submit an app*. 2) Upload the marketplace zip. 3) Paste the copy below. 4) Screenshots: the sidebar with a draft detected, the reason chips, the Capture page scorecard (1280×800 PNGs; `pnpm --filter @overturn-ai/web e2e` leaves them under `apps/web/test-results/`). 5) Pricing: free. 6) Submit; Zendesk review is 2–4 weeks and asks about what the app reads (answer is the *Review notes* section).

**Name:** Overturn — QA for AI-drafted replies

**Short description (80 chars):** Score your AI drafts: untouched rate, fixes by reason, and tests before each change.

**Long description:**

Your agents already review every AI-drafted reply before it goes out. Overturn records what the AI wrote, what the agent sent and why it changed, from the ticket sidebar, with a one-click reason. Works with any drafting tool: Zendesk AI agents, a bot from another vendor, a macro or your own model.

What you get:

- The AI draft scorecard: how often drafts go out untouched, which reasons drive the fixes, and how long drafts sit before sending, by team and by week. Never a per-agent rate.
- A regression suite that runs before the next model or prompt change: every fix replays against the new model, and a draft that would reintroduce an old mistake fails the check.
- The correction record (draft, sent, reason, who, when), exportable with redaction, for QA reviews and audits.

Privacy: the app reads a ticket only after an AI draft appears in its reply box; a human-only thread is never read. An optional scope tag limits it to the tickets you choose. Self-host Overturn and nothing leaves your network, model calls included.

**Categories:** Quality assurance; AI & bots; Reporting & analytics.

**Setup:** Install, paste a project API key from Overturn (Settings → API keys), optionally name your decision fields and a scope tag. First capture within a minute.

**Support:** shireen@overturn.run · https://docs.overturn.run/docs/capture/

**Review notes (what the app reads):** `ticket.comment.text` continuously (to detect an inserted draft); on submit with a draft present: comments, subject, requester, chosen custom fields, current user email. Nothing else, never before a draft. Source: https://github.com/overturn-ai/overturn/tree/main/packages/zendesk-app
