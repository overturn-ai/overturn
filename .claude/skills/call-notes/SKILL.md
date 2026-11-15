---
name: call-notes
description: File a customer, prospect or design-partner call into the wiki. Use when Shireen pastes or drops a transcript (Granola, Zoom, a voice note) or says to file a call.
---

# Call notes

Calls are the data nobody else has. Every call gets filed the same day, in the same shape, so agents quote customers instead of guessing.

Input: a transcript or notes, pasted, or a file in `docs/wiki/calls/inbox/`. That folder is git-ignored. Raw transcripts are never committed.

Output: one file per call at `docs/wiki/calls/<YYYY-MM-DD>-<who>.md`, in this shape:

```
# <date> · <who> · <prospect | design partner | customer | churned>
source: <Granola | Zoom | voice note>, <minutes> min

## What they said
- <exact quote> (on <topic>)
  five to ten quotes, their words, no paraphrase

## The problem as they describe it
## What they use today and what it costs them
## Objections and questions
## What they asked for
## Commitments: ours and theirs, with dates
## Signals
budget: ... · who decides: ... · timeline: ... · next step: ...

## For the brain
- facts.md: a claim this call supports or contradicts. Propose it; do not edit facts.md.
- glossary.md: their word for something we call by another name.
- Linear: a request worth a spec. Run spec-writing and link the issue.
```

Rules
- Quotes are exact. Where the transcript is unclear write [unclear]. Never guess.
- Everything above Signals is what they said. Your own read goes under Signals, one line each, marked (my read).
- Who: a code only (DP-01 for a design partner, P-07 for a prospect). This repo is public: no person, company, product or number that identifies them goes in the file. The key from code to name lives outside the repo. Leave budget and spend figures out too: write has budget or no budget, never the amount.
- Never commit the raw transcript, a recording link, an email address or a phone number.
- Add one row to the table in `docs/wiki/calls/README.md`: date, who, stage, one-line takeaway.
- If the call contradicts `docs/wiki/facts.md`, say so at the top of the PR description.
- Branch, commit as Shireen Kadhium <shireenkadhium1@gmail.com> with no trailers, open a PR. Put the takeaway on the learned line of the nightly log.
