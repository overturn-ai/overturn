---
name: complaint-mining
description: Pull G2, Reddit, App Store, Capterra and community reviews of competitors with Apify, find the 10 complaints that show up most and quote the users. Use for positioning, roadmap, and landing-page copy.
---

# Complaint mining

Tools: Apify MCP (actors: `apify/g2-reviews`, `trudax/reddit-scraper` or `apify/reddit-scraper-lite`, `apify/app-store-reviews`, `apify/capterra-reviews`), Exa for discovering threads, Firecrawl for pages Apify does not cover.

Competitor list and subreddits live in CLAUDE.md under "Market".

Prompt to run after the pull (verbatim):
> find the 10 complaints that show up most and quote the users

Procedure
1. Pull the last 12 months for each competitor. Cap at 500 reviews per source per competitor. Save raw JSON to `research/complaints/<date>/raw/` (gitignored).
2. Cluster by complaint, not by product. One cluster = one job the user could not get done.
3. For each of the top 10: count, share of all complaints, 2–3 verbatim quotes under 25 words each with source + date, which competitors it hits, and whether we already solve it (yes / partly / no).
4. Output `research/complaints/<date>/top-10.md` and a 10-line summary to Shireen. The summary leads with the top complaint we solve and the top one we do not.
5. Anything we solve goes to the landing page copy backlog; anything we do not solve becomes a `/grill-me` candidate, not a Linear issue yet.

Never paraphrase a quote into something stronger than the user said.
