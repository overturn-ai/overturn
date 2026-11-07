#!/usr/bin/env bash
# PreToolUse hook (Edit|Write|MultiEdit). Reads the tool call JSON on stdin.
# Exit 2 = block with the message on stderr. Exit 0 = allow (warnings on stdout are shown to the agent).
set -euo pipefail
input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.path // empty')
content=$(printf '%s' "$input" | jq -r '.tool_input.content // .tool_input.new_string // empty')
[ -z "$path" ] && exit 0

case "$path" in
  *.env|*.env.local|*.env.production|*/.env|*/.env.*) 
    echo "BLOCKED: agents never write to env files. Add the key name to .env.example and tell Shireen which secret to set." >&2; exit 2;;
  *pnpm-lock.yaml|*package-lock.json) exit 0;;
esac

warn() { echo "SECURITY WARNING ($path): $1"; }
if printf '%s' "$content" | grep -Eq '(sk_live_|sk_test_|ov_live_|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY)'; then
  echo "BLOCKED: looks like a real secret is being written into source. Use an env var." >&2; exit 2
fi
printf '%s' "$content" | grep -Eq 'dangerouslySetInnerHTML' && warn "dangerouslySetInnerHTML — sanitize or use text."
printf '%s' "$content" | grep -Eq '\beval\(|new Function\(' && warn "eval/new Function — almost never needed."
printf '%s' "$content" | grep -Eq 'child_process|execSync\(|exec\(`' && warn "shell exec with interpolation — pass args as an array, never template strings."
printf '%s' "$content" | grep -Eq '\$queryRawUnsafe|\$executeRawUnsafe|sql\.raw\(' && warn "raw SQL — parameterize it."
printf '%s' "$content" | grep -Eq 'rejectUnauthorized:\s*false|NODE_TLS_REJECT_UNAUTHORIZED' && warn "TLS verification disabled."
printf '%s' "$content" | grep -Eq "Access-Control-Allow-Origin['\"]?\s*[:,]\s*['\"]\*" && warn "wildcard CORS."
printf '%s' "$content" | grep -Eq 'fetch\((req|request|params|searchParams|body)\.' && warn "fetching a user-supplied URL — SSRF; allowlist hosts."
exit 0
