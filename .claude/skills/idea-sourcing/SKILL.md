---
name: idea-sourcing
description: Where ideas and trends come from before they get grilled — ideabrowser.com, complaint mining, competitor changelogs, Shireen's voice notes. Use when asked "what should we build next" or "find ideas/trends for <product>".
---

# Idea sourcing

Ideas are inputs to `/grill-me`, never to a spec. Four sources, in order of signal:

1. **Customer complaints** — run the complaint-mining skill. A complaint we can solve that competitors leave open is the best idea there is.
2. **ideabrowser.com** — Firecrawl `scrape` the daily idea and the trends pages; filter to anything touching compliance-as-a-service, Shopify brands, 3PLs (Tare) or support QA, insurance claims, AI evaluation (Overturn). Record the idea, the stated trend evidence, and the URL. Ignore anything that is "build an AI wrapper for X".
3. **Competitor changelogs** — the competitor-watch skill's weekly diff. A feature two competitors shipped in the same month is a signal; one competitor is noise.
4. **Shireen's voice notes** — transcribe faithfully, then rewrite as one sentence of problem + one sentence of who has it. Do not add scope.

Output: `research/ideas/<date>.md` with ≤5 ideas, each: one-line problem, who has it, evidence link, which wedge in CLAUDE.md it strengthens (or "none" — then drop it). Hand the top one to `/grill-me`. Never open a Linear issue from this skill.
