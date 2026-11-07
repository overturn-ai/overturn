#!/usr/bin/env bash
# Stop hook: append a 5-line session log to the wiki so the whole company reads in 2 minutes.
# The agent is told (via CLAUDE.md) to end every session by writing docs/wiki/log/YYYY-MM-DD.md itself;
# this hook just guarantees the file exists and the git-backed wiki stays append-only.
set -euo pipefail
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
day=$(date -u +%F)
f="$root/docs/wiki/log/$day.md"
mkdir -p "$(dirname "$f")"
if [ ! -f "$f" ]; then
  printf '# %s\n\n<!-- one entry per agent session, max 5 lines each: what shipped / what broke / what I learned / what needs a human / score -->\n' "$day" > "$f"
fi
echo "Nightly log for $day is at docs/wiki/log/$day.md — append your 5 lines if you have not."
exit 0
