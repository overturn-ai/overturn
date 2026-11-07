---
name: mistake-to-skill
description: Every agent mistake becomes a new skill (or a line in an existing one) so it only happens once. Use whenever Shireen corrects you, a judge round fails, CI fails on something avoidable, or a persona test finds a blocker you caused.
---

# Mistake → skill

1. Write the mistake in one line: what you did, what should have happened. No apology.
2. Decide where it lives:
   - A rule about *this codebase* → `CLAUDE.md` (keep it under 2 lines; CLAUDE.md is for rules, not stories).
   - A rule about *how we design* → `.claude/skills/design-system/SKILL.md`.
   - A rule about *how we write* → `.claude/skills/writing-voice/SKILL.md`.
   - A reusable *procedure* → new skill via `skill-creator` (`.claude/skills/<name>/SKILL.md`), with a description that names the trigger situation precisely.
3. Append to `docs/wiki/mistakes.md`: date, one-line mistake, where the fix landed.
4. Commit alongside the fix for the mistake itself.

Rules: a skill is small and specific; if it is growing past ~150 lines, split it. Never add a rule that says "be careful" — say what to do instead.
