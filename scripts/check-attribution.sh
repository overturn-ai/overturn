#!/usr/bin/env bash
# Every commit on this branch is Shireen's, with no agent trailers. CLAUDE.md says so in prose;
# this is the half that holds on the day an agent reads the prose and does it anyway.
#
# Usage: bash scripts/check-attribution.sh [base-ref]   (default: origin/main)
set -euo pipefail

BASE="${1:-origin/main}"
WANT_NAME="Shireen Kadhium"
WANT_EMAIL="shireenkadhium1@gmail.com"
# Case-insensitive, and loose about spacing, because the point is to catch the thing however
# it is spelled rather than to be beaten by a lowercase o.
BANNED='co-authored-by|claude-session|generated with \[?claude|co-written-by|assisted-by: *claude|🤖'

git rev-parse --verify --quiet "$BASE" >/dev/null || {
  echo "attribution: no such ref '$BASE' — fetch it first" >&2
  exit 1
}

# --no-merges: on a pull_request event actions/checkout gives GitHub's synthetic merge commit,
# authored by the PR opener's noreply address and committed by GitHub itself. It is not anyone's
# work and never reaches main. A real merge commit is nobody's authored change either.
range="$BASE..HEAD"
commits=$(git rev-list --no-merges "$range")
if [ -z "$commits" ]; then
  echo "attribution: no commits in $range, nothing to check"
  exit 0
fi

fail=0
for sha in $commits; do
  short=$(git log -1 --format='%h %s' "$sha")
  an=$(git log -1 --format='%an' "$sha"); ae=$(git log -1 --format='%ae' "$sha")
  cn=$(git log -1 --format='%cn' "$sha"); ce=$(git log -1 --format='%ce' "$sha")

  if [ "$an" != "$WANT_NAME" ] || [ "$ae" != "$WANT_EMAIL" ]; then
    echo "FAIL $short"; echo "     author is '$an <$ae>', must be '$WANT_NAME <$WANT_EMAIL>'"; fail=1
  fi
  if [ "$cn" != "$WANT_NAME" ] || [ "$ce" != "$WANT_EMAIL" ]; then
    echo "FAIL $short"; echo "     committer is '$cn <$ce>', must be '$WANT_NAME <$WANT_EMAIL>'"; fail=1
  fi
  if hit=$(git log -1 --format='%B' "$sha" | grep -Ein "$BANNED" | head -3); then
    echo "FAIL $short"; echo "     message carries an agent trailer:"
    printf '       %s\n' "$hit"; fail=1
  fi
done

# The PR body and title go through the same rule. GitHub puts them in the event payload.
if [ -n "${GITHUB_EVENT_PATH:-}" ] && [ -f "${GITHUB_EVENT_PATH}" ]; then
  body=$(jq -r '.pull_request.body // ""' "$GITHUB_EVENT_PATH")
  title=$(jq -r '.pull_request.title // ""' "$GITHUB_EVENT_PATH")
  if hit=$(printf '%s\n%s' "$title" "$body" | grep -Ein "$BANNED" | head -3); then
    echo "FAIL pull request title or body carries an agent trailer:"
    printf '       %s\n' "$hit"; fail=1
  fi
fi

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

Fix without force-pushing: `git commit --amend --reset-author` on the last commit and push
normally if nothing is pushed yet. If it is already pushed, leave the history alone and say so
in the pull request — a wrong name in one commit message costs less than a rewritten branch.
MSG
  exit 1
fi

echo "attribution: $(echo "$commits" | wc -l | tr -d ' ') commit(s) clean"
