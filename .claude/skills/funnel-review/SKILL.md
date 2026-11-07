---
name: funnel-review
description: 7am review of yesterday's funnel in PostHog. Any step that drops more than 10% vs its 7-day average → watch 20 session replays and explain why. Use when the daily funnel task fires or when asked about conversion.
---

# Funnel review

Funnel steps per product are in CLAUDE.md under "Funnel".

1. PostHog MCP: run the funnel insight for yesterday (UTC) and for the trailing 7 days. Step-to-step conversion for both.
2. For every step whose yesterday conversion is more than 10 percentage points below the 7-day average (or more than 25% relative, whichever is smaller), pull 20 session recordings that reached the step and did not reach the next. Prefer recordings with rage clicks, console errors, or >30s dwell.
3. Watch them (recording events + console + network via PostHog MCP). Group by what the user was doing when they left. Name the top 2 causes with counts out of 20 and one quoted/observed behavior each.
4. Cross-check Sentry for new issues in the same window on the same route.
5. Report, under 200 words: the funnel table (yesterday vs 7d), the drop(s), the why, and one concrete fix or "no action — noise" with the evidence. Send with SendUserMessage. Write the same to `docs/wiki/funnel/<date>.md`.
6. If the fix is clear and small, open the Linear issue labelled `agent-ready` with the replay links in the body.

No drop over 10%: say so in two lines and stop. Do not pad.
