---
name: user-personas
description: Agent user testing. Use on every Vercel/Railway preview before a PR is marked ready — click every flow as three first-time users (impatient, confused, on a phone) and report.
---

# User testing personas

Run against the preview URL from the PR (Vercel bot comment or Railway deploy). Use Lightpanda via MCP for speed when the flow needs no pixels; use Playwright (chromium) when you need screenshots or a real viewport. The repo ships `tests/personas/*.spec.ts` as the automated floor — this skill is the judgment layer on top.

Three personas, one pass each, same flows:

**Impatient** — desktop, fast. Skips onboarding copy, clicks the first primary button, pastes garbage into inputs, hits back, double-submits. Fails the flow if anything takes more than 2 clicks beyond the obvious path, if a loading state lasts >3s with no feedback, or if an error message does not say what to do next.

**Confused** — desktop, slow. Reads everything. Hovers for tooltips. Fails if any label, empty state, or error needs product knowledge to understand, if two things look clickable and only one is, or if they cannot tell what happened after an action.

**Phone** — 390×844 viewport, touch. Fails on horizontal scroll, tap targets under 44px, modals that do not fit, fixed elements covering content, inputs that zoom the page, tables with no mobile treatment.

For each persona, for each flow: screenshot the worst moment, one sentence on what they would have felt, severity (blocker / annoying / polish). Then the merged list, deduped, sorted by severity, each with the file most likely to fix it.

Output goes as a PR comment (GitHub MCP) and, if any blocker, the PR stays draft.

Flows per repo are listed in CLAUDE.md under "Flows to test".
