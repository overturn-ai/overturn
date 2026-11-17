#!/usr/bin/env bash
# PreToolUse hook (Bash). Reads the tool call JSON on stdin.
# Exit 2 = block with the message on stderr. Exit 0 = allow.
#
# The deny list in settings.json matches on a literal prefix, so `git push --force*` catches
# `git push --force-with-lease origin x` and misses `git push -q --force-with-lease origin x`.
# One flag in front of the other and the wall is not there. That is how CLAUDE.md's "never
# force-push" got broken on 2026-11-16 by an agent that had read the rule and agreed with it.
#
# This reads the whole command instead of its first characters, so flag order cannot defeat it.
set -euo pipefail
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

# Each && / || / ; / | segment is its own command; a guard that only reads the first one is
# defeated by `echo hi && git push --force`.
# `|| [ -n "$seg" ]` because read returns non-zero on a final line with no newline after it,
# which is every command we are handed. Without it this loop silently inspects nothing.
while IFS= read -r seg || [ -n "$seg" ]; do
  seg=$(printf '%s' "$seg" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  [ -z "$seg" ] && continue

  case "$seg" in
    git\ push*|git\ *\ push*)
      if printf '%s' "$seg" | grep -Eq '(^|[[:space:]])(-f|--force|--force-with-lease|--force-if-includes)([=[:space:]]|$)'; then
        cat >&2 <<'MSG'
BLOCKED: never force-push (CLAUDE.md, Git and attribution).

This holds on agent branches too, including to fix your own commit message. A message
that came out wrong is worth less than a branch somebody else may have already pulled.

Instead: push a new commit, or if nothing is pushed yet, amend and push normally.
MSG
        exit 2
      fi
      ;;
    git\ reset\ --hard*|git\ *\ reset\ --hard*)
      echo "BLOCKED: git reset --hard discards work that is not recoverable from the index. Use git stash, or git restore for named paths." >&2
      exit 2
      ;;
    git\ merge*|gh\ pr\ merge*)
      # CLAUDE.md: never merge your own PR. What that forbids is landing work ON main.
      #
      # Merging origin/main INTO a feature branch is the opposite act, and with force-push and
      # rebase both off the table it is the only way to take a conflicted branch forward. An
      # earlier version of this rule matched "main" anywhere in the command and blocked that too,
      # which would have left every conflicted agent branch stuck.
      branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
      if printf '%s' "$seg" | grep -Eq '^gh pr merge'; then
        echo "BLOCKED: never merge your own PR (CLAUDE.md). Open it and hand it over; Shireen merges." >&2
        exit 2
      fi
      if [ "$branch" = "main" ] && printf '%s' "$seg" | grep -Eq '^git +merge'; then
        echo "BLOCKED: that merges a branch into main, which is Shireen's to do (CLAUDE.md)." >&2
        echo "To take your branch forward instead: switch to it and merge origin/main into it." >&2
        exit 2
      fi
      ;;
  esac
done < <(printf '%s' "$cmd" | sed 's/&&/\n/g; s/||/\n/g; s/;/\n/g; s/|/\n/g')

exit 0
