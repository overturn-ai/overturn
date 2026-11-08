#!/usr/bin/env bash
# Connect this machine's Claude Code to the agent services in this repo's .mcp.json. Run once per
# machine; safe to rerun. The same script ships in the Tare, Overturn and Fluorine repos.
#
#   bash scripts/connect.sh            authorize what is missing, prompt for keys that are missing
#   bash scripts/connect.sh --status   only print the table
#   bash scripts/connect.sh --all      re-run every OAuth login and re-prompt every key
#
# The server list comes from .mcp.json itself:
#   - remote servers without a header are OAuth: `claude mcp login <name>` opens the browser once each,
#     you click Authorize; tokens live in Claude Code's credential store and are shared by every Claude
#     Code process on this machine (terminal, T3 Code, Agent SDK) and by every repo naming the same server
#   - servers whose env/args reference ${VAR} take a key: prompted with hidden input and written to
#     ~/.claude/settings.json → env, which Claude Code applies at startup however it was launched
#   - github sends your `gh auth token` (headersHelper) and railway uses the Railway CLI login; the
#     script only checks those CLIs are signed in
# Nothing is echoed, logged or committed.
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-}"
SETTINGS="$HOME/.claude/settings.json"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
dim()  { printf '  \033[2m%s\033[0m\n' "$*"; }

need() { command -v "$1" >/dev/null 2>&1 || { bad "missing: $1"; exit 1; }; }
need claude
need node
[ -f .mcp.json ] || { bad "no .mcp.json in $(pwd)"; exit 1; }

CLAUDE_VERSION="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
if ! version_ge "${CLAUDE_VERSION:-0.0.0}" "2.1.186"; then
  bad "Claude Code ${CLAUDE_VERSION:-?} is too old for 'claude mcp login' (needs 2.1.186+). Run: claude update"
  exit 1
fi

# ---- what .mcp.json asks for ------------------------------------------------------------------------
# prints lines:  oauth <name>  |  key <name> <VAR>  |  cli <name>
read_mcp() {
  node -e '
    const s = JSON.parse(require("fs").readFileSync(".mcp.json", "utf8")).mcpServers || {};
    const cli = { github: 1, railway: 1 };
    for (const [name, c] of Object.entries(s)) {
      if (cli[name]) { console.log("cli", name); continue; }
      const text = JSON.stringify([c.env || {}, c.args || [], c.headers || {}, c.url || ""]);
      const vars = [...new Set([...text.matchAll(/\$\{([A-Z0-9_]+)(?::-[^}]*)?\}/g)].map(m => m[1]))].filter(v => v !== "HOME");
      if (c.type === "http" && /^https:/.test(c.url || "") && !c.headers && !c.headersHelper) console.log("oauth", name);
      for (const v of vars) console.log("key", name, v);
    }'
}
MCP="$(read_mcp)"
OAUTH_SERVERS=($(printf '%s\n' "$MCP" | awk '$1=="oauth"{print $2}'))
CLI_SERVERS=($(printf '%s\n' "$MCP" | awk '$1=="cli"{print $2}'))
KEY_ROWS="$(printf '%s\n' "$MCP" | awk '$1=="key"{print $2"|"$3}')"

# VAR -> required|where to get it   (anything not listed is optional)
key_info() {
  case "$1" in
    FIRECRAWL_API_KEY)  echo "1|https://www.firecrawl.dev/app/api-keys" ;;
    AGENTPHONE_API_KEY) echo "1|https://agentphone.ai → Settings → API keys" ;;
    ORGO_API_KEY)       echo "0|https://www.orgo.ai → API keys (only for agents that need their own desktop)" ;;
    CONTEXT7_API_KEY)   echo "0|https://context7.com/dashboard (optional, raises the rate limit)" ;;
    DATABASE_URL)       echo "0|your Postgres URL (optional; the default in .mcp.json is the local dev database)" ;;
    *)                  echo "0|see .env.example" ;;
  esac
}

# ---- status -----------------------------------------------------------------------------------------
LIST=""
refresh_list() { LIST="$(claude mcp list 2>/dev/null || true)"; }
status_of() {  # connected | needs-auth | pending | failed | unknown
  local line
  line="$(printf '%s\n' "$LIST" | grep -iE "^$1:" | head -1)"
  case "$line" in
    *Connected*)        echo connected ;;
    *[Nn]eeds*auth*)    echo needs-auth ;;
    *[Pp]ending*)       echo pending ;;
    *[Ff]ailed*)        echo failed ;;
    "")                 echo unknown ;;
    *)                  echo failed ;;
  esac
}
any_pending() { printf '%s\n' "$LIST" | grep -qiE 'Pending approval'; }

settings_has() {  # VAR -> 0 if set non-empty in process env or settings.json env
  [ -n "${!1:-}" ] && return 0
  node -e '
    const fs = require("fs"); const [p, k] = process.argv.slice(1);
    try { const s = JSON.parse(fs.readFileSync(p, "utf8")); process.exit(s.env && s.env[k] ? 0 : 1); } catch { process.exit(1); }
  ' "$SETTINGS" "$1"
}

settings_set() {  # VAR  (value arrives in $CONNECT_VALUE so it never appears in argv or history)
  mkdir -p "$(dirname "$SETTINGS")"
  CONNECT_KEY="$1" node -e '
    const fs = require("fs"); const p = process.argv[1];
    let s = {}; try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    s.env = s.env || {}; s.env[process.env.CONNECT_KEY] = process.env.CONNECT_VALUE;
    fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  ' "$SETTINGS"
  chmod 600 "$SETTINGS" 2>/dev/null || true
}

cli_signed_in() {
  case "$1" in
    github)  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 ;;
    railway) command -v railway >/dev/null 2>&1 && railway whoami >/dev/null 2>&1 ;;
    *)       return 1 ;;
  esac
}
cli_hint() { case "$1" in github) echo "gh auth login" ;; railway) echo "npm i -g @railway/cli && railway login" ;; esac; }

print_table() {
  bold "Connections ($(basename "$(pwd)"))"
  for s in "${OAUTH_SERVERS[@]}"; do
    case "$(status_of "$s")" in
      connected)  ok  "$s" ;;
      needs-auth) bad "$s — needs authorizing" ;;
      pending)    bad "$s — project servers not approved on this machine yet" ;;
      failed)     bad "$s — failed to connect" ;;
      unknown)    dim "$s — not configured here" ;;
    esac
  done
  for s in "${CLI_SERVERS[@]}"; do
    case "$(status_of "$s")" in
      connected) ok "$s (via the $([ "$s" = github ] && echo gh || echo "$s") CLI login)" ;;
      unknown)   dim "$s — not configured here" ;;
      *)         if cli_signed_in "$s"; then bad "$s — CLI is signed in but the server did not connect ($(status_of "$s"))"; else bad "$s — run: $(cli_hint "$s")"; fi ;;
    esac
  done
  while IFS='|' read -r s var; do
    [ -n "$var" ] || continue
    IFS='|' read -r req _ <<<"$(key_info "$var")"
    if settings_has "$var"; then
      case "$(status_of "$s")" in connected) ok "$s" ;; *) bad "$s — $var is set but the server is not connecting ($(status_of "$s"))" ;; esac
    elif [ "$req" = "1" ]; then bad "$s — $var missing"
    else dim "$s — $var not set (optional)"; fi
  done <<<"$KEY_ROWS"
}

refresh_list
if [ "$MODE" = "--status" ]; then print_table; exit 0; fi
if any_pending; then
  print_table
  echo
  bad "Claude Code has not approved this project's .mcp.json servers on this machine."
  dim "Run \`claude\` once in this folder, accept the trust prompt (the project enables all its servers), then rerun."
  exit 1
fi

# ---- OAuth ------------------------------------------------------------------------------------------
bold "Authorizing (a browser tab opens for each; click Authorize)"
for s in "${OAUTH_SERVERS[@]}"; do
  st="$(status_of "$s")"
  if [ "$MODE" != "--all" ] && [ "$st" = "connected" ]; then ok "$s already connected"; continue; fi
  printf '  → %s  (Ctrl-C skips this one)\n' "$s"
  # Foreground, with the terminal as stdin: the login keeps its local callback listener open until the
  # browser redirects back. A background job would get /dev/null as stdin and exit before you click.
  trap 'printf "\n"; dim "skipped"' INT
  if [ -n "${SSH_CONNECTION:-}" ] || [ "${CONNECT_NO_BROWSER:-}" = "1" ]; then
    claude mcp login "$s" --no-browser || true
  else
    claude mcp login "$s" || true
  fi
  trap - INT
done

# ---- CLI logins -------------------------------------------------------------------------------------
if [ "${#CLI_SERVERS[@]}" -gt 0 ]; then
  bold "CLI logins"
  for s in "${CLI_SERVERS[@]}"; do
    if cli_signed_in "$s"; then ok "$s — CLI signed in"; else bad "$s — not signed in on this machine; run: $(cli_hint "$s")   (then rerun)"; fi
  done
fi

# ---- keys -------------------------------------------------------------------------------------------
bold "Keys (hidden input, stored in ~/.claude/settings.json → env; Enter skips)"
while IFS='|' read -r s var; do
  [ -n "$var" ] || continue
  IFS='|' read -r req where <<<"$(key_info "$var")"
  if [ "$MODE" != "--all" ] && settings_has "$var"; then ok "$var already set"; continue; fi
  if [ "$req" = "0" ] && [ "$MODE" != "--all" ]; then dim "$var optional — skipping (--all to set it)"; continue; fi
  printf '  %s ← %s\n' "$var" "$where"
  printf '  paste %s: ' "$var"
  IFS= read -rs CONNECT_VALUE </dev/tty; printf '\n'
  if [ -z "$CONNECT_VALUE" ]; then dim "skipped"; continue; fi
  export CONNECT_VALUE
  settings_set "$var"
  unset CONNECT_VALUE
  ok "$var stored"
done <<<"$KEY_ROWS"

# ---- verify -----------------------------------------------------------------------------------------
echo
refresh_list
print_table
echo
dim "Claude Code reads settings.json at startup: restart any open session (and T3 Code threads) to pick up new keys."
