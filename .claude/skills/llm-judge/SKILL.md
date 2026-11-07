---
name: llm-judge
description: Score any agent output 1–10 before it reaches Shireen or ships. Under 8 goes back. Use at the end of every task — specs, PRs, copy, designs, outreach, reports.
---

# LLM judge

Every output gets scored before it is handed over. The judge is a fresh subagent (`.claude/agents/judge.md`) that has not seen the work being produced — never self-score.

Rubric (each 0–2, sum is the score):
1. **Correct** — does what the spec/ask says, nothing invented, numbers sourced.
2. **Complete** — nothing the spec's "Done when" still fails; edge cases the personas would hit are handled.
3. **Tight** — no filler, no dead code, no "various improvements". Would survive the writing-voice skill.
4. **Safe** — no secrets, no raw SQL, no unbounded user input reaching a shell/URL/HTML; tests exist for the risky bit.
5. **Taste** — fits the design-system skill and the repo's conventions; a reviewer would not ask "why is this different".

Under 8: the judge writes the specific failing criteria and the smallest change that fixes each. The producing agent fixes and resubmits. Max 3 rounds; after that it goes to Shireen flagged `needs-human` with the judge notes attached.

8–10: hand over with the score and the one thing the judge would still improve.

The score and the judge's note go in the nightly log line for the task.
