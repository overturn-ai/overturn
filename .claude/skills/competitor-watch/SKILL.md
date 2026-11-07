---
name: competitor-watch
description: Read every competitor site, pricing page and changelog with Exa + Firecrawl and diff against last run. Use weekly or when asked "what changed at <competitor>".
---

# Competitor watch

Competitors and the URLs to watch are in CLAUDE.md under "Market".

1. Exa (`web_search_exa` / `crawling_exa`) to find new pages: pricing, changelog, blog, docs index, careers (hiring tells you the roadmap).
2. Firecrawl `scrape` each watched URL to markdown. Store under `research/competitors/<slug>/<date>.md` (gitignored, kept locally; summary is what gets committed).
3. Diff against the previous run's file. Ignore boilerplate; report: new features, pricing or packaging changes, new integrations, positioning changes (hero copy), new case studies / logos, hiring signals.
4. Write `docs/wiki/competitors.md` section for the week: 1 paragraph per competitor with changes only. "No change" is a valid and common entry.
5. Flag anything that touches our wedge (see CLAUDE.md) as `needs shireen` in the nightly log.

Do not editorialize about whether a competitor is "winning". Report what changed.
