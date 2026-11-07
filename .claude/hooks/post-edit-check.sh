#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): fast typecheck on TS edits so the agent sees errors like an IDE does.
set -uo pipefail
input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
case "$path" in *.ts|*.tsx) ;; *) exit 0;; esac
root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
pkg=$(cd "$(dirname "$path")" && while [ "$PWD" != "/" ] && [ ! -f package.json ]; do cd ..; done; pwd)
[ -f "$pkg/tsconfig.json" ] || exit 0
out=$(cd "$pkg" && timeout 90 npx tsc --noEmit -p tsconfig.json 2>&1 | grep -F "$(realpath --relative-to="$pkg" "$path")" | head -15)
[ -n "$out" ] && printf 'TYPE ERRORS in %s:\n%s\n' "$path" "$out"
exit 0
