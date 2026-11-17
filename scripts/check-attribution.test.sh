#!/usr/bin/env bash
# The check has to fail on purpose before it is worth trusting. Builds a throwaway repo so the
# cases are exact and nothing depends on this repo's real history.
# Run: bash scripts/check-attribution.test.sh
set -uo pipefail
SCRIPT="$(cd "$(dirname "$0")" && pwd)/check-attribution.sh"
pass=0; fail=0

expect() { # expect <want-exit> <label>
  local want="$1" label="$2" got
  bash "$SCRIPT" main >/dev/null 2>&1; got=$?
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL ($label): expected $want, got $got"; fi
}

tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cd "$tmp"
git init -q -b main .
git config user.name "Shireen Kadhium"; git config user.email "shireenkadhium1@gmail.com"
echo base > base.txt; git add .; git commit -q -m "base"
git checkout -q -b work

commit() { # commit <name> <email> <message>
  echo "$RANDOM" > f.txt; git add f.txt
  git -c user.name="$1" -c user.email="$2" commit -q -m "$3"
}

commit "Shireen Kadhium" "shireenkadhium1@gmail.com" "clean commit"
expect 0 "a clean commit passes"

commit "Some Agent" "agent@example.com" "wrong author"
expect 1 "a wrong author fails"
git reset -q --hard HEAD~1

commit "Shireen Kadhium" "shireenkadhium1@gmail.com" "trailer

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
expect 1 "a Co-Authored-By trailer fails"
git reset -q --hard HEAD~1

commit "Shireen Kadhium" "shireenkadhium1@gmail.com" "lowercase trailer
co-authored-by: someone <x@y.z>"
expect 1 "the trailer check ignores case"
git reset -q --hard HEAD~1

commit "Shireen Kadhium" "shireenkadhium1@gmail.com" "robot
🤖 Generated with Claude Code"
expect 1 "a generated-with line fails"
git reset -q --hard HEAD~1

# GitHub's synthetic merge commit on a pull_request event is authored by GitHub itself. It is
# nobody's work and must not fail the branch — this is the bug this file exists because of.
git checkout -q -b side main
echo side > side.txt; git add side.txt; git commit -q -m "side"
git checkout -q work
git -c user.name="GitHub" -c user.email="noreply@github.com" merge -q --no-ff side -m "Merge pull request #1"
expect 0 "a GitHub merge commit is skipped, not failed"

echo "check-attribution: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
