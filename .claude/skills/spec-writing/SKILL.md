---
name: spec-writing
description: How we write specs. Use after /grill-me, before any build — turns the grilled idea into a spec and files it in Linear via the Linear MCP.
---

# Spec writing

Flow: voice note / rough idea → `/grill-me` (interrogate until every branch is decided) → this skill → Linear issue(s) → build.

Never write a spec for an idea that has not been grilled. If `/grill-me` has not run in this session, run it first.

## Spec format (one Linear issue per shippable unit)

Title: imperative, under 60 chars, names the user-visible result. "Show fee estimate per state on the dashboard", not "Fees work".

Body:
```
## Why
One paragraph. The user problem, who has it, how we know (quote the complaint or the session replay if we have one).

## What
What the user can do after this ships that they cannot do now. Plain language, 3–6 sentences. No implementation.

## Decisions made in grilling
Bullets. Each is a question that came up and the answer. This is the part that stops re-litigation later.

## Not in scope
Bullets. Things that came up and were explicitly deferred, with the reason.

## Done when
Checklist a tester can run without talking to the author. Includes the three personas (impatient / confused / phone) where UI is involved.

## Design
Link to the Paper artboard(s) — 4 versions, with the merge noted. Or "no UI".

## Risk
One line: data, money, security, or "none".
```

## Linear filing
- Team: the product's team. Project: the current milestone.
- Labels: `agent-ready` when an agent can take it unattended overnight; `needs-human` when a decision is outstanding; `design` when it needs the four-versions pass first.
- Estimate in the Linear field, not the body. Anything over 3 points gets split.
- Link the issue back to the grilling transcript (paste the decisions section, not the whole chat).

## Rules
- Specs describe outcomes, not components. If a spec names a React component, rewrite it.
- Every number in a spec has a source (link, replay, quote). No invented metrics.
- Humans get the spec, never the voice note.
