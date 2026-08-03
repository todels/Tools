#!/usr/bin/env bash
# One-shot setup for Font Sync. Checks your environment, points you at the one
# step that has to happen in the Supabase dashboard, verifies the backend,
# signs you in, and starts the watcher.
#
#   ./setup.sh
#
# Non-interactive (used by the tests):
#   FONTSYNC_URL=... FONTSYNC_KEY=... FONTSYNC_EMAIL=... FONTSYNC_PASSWORD=... \
#     ./setup.sh --no-start --skip-schema

set -euo pipefail
cd "$(dirname "$0")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; OFF=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$OFF"; }
ok()   { printf '%s  ✓ %s%s\n' "$GREEN" "$1" "$OFF"; }
warn() { printf '%s  ! %s%s\n' "$YELLOW" "$1" "$OFF"; }
die()  { printf '%s  ✗ %s%s\n' "$RED" "$1" "$OFF" >&2; exit 1; }

START=1
SKIP_SCHEMA=0
for arg in "$@"; do
  case "$arg" in
    --no-start)    START=0 ;;
    --skip-schema) SKIP_SCHEMA=1 ;;
    -h|--help)     sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown option: $arg" ;;
  esac
done

# --- 1. environment ----------------------------------------------------------
step "Checking your setup"

command -v node >/dev/null 2>&1 || die "Node isn't installed. Get the LTS build from https://nodejs.org and run this again."

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || die "Node $(node -v) is too old — this needs v20 or newer. Update from https://nodejs.org"
ok "Node $(node -v)"

case "$(uname -s)" in
  Darwin) ok "macOS — watching ~/Library/Fonts and /Library/Fonts" ;;
  Linux)  ok "Linux — watching ~/.local/share/fonts and friends" ;;
  *)      warn "Unrecognised OS; check watchDirs in ~/.fontsync/config.json" ;;
esac

# --- 2. credentials ----------------------------------------------------------
step "Supabase project"

CONFIG_FILE="${FONTSYNC_HOME:-$HOME/.fontsync}/config.json"

# Reuse anything already configured, then fall back to the values in the
# sibling app's index.html, then ask.
read_config() { [ -f "$CONFIG_FILE" ] && node -p "try{JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8')).$1||''}catch(e){''}" || echo ''; }

URL="${FONTSYNC_URL:-$(read_config supabaseUrl)}"
KEY="${FONTSYNC_KEY:-$(read_config supabaseAnonKey)}"

if [ -z "$URL" ] && [ -f ../index.html ]; then
  URL=$(grep -o "const SUPABASE_URL = '[^']*'" ../index.html | head -1 | cut -d"'" -f2 || true)
  KEY=$(grep -o "const SUPABASE_KEY = '[^']*'" ../index.html | head -1 | cut -d"'" -f2 || true)
  [ -n "$URL" ] && ok "Found your project in index.html: $URL"
fi

[ -n "$URL" ] || read -r -p "  Supabase project URL: " URL
[ -n "$KEY" ] || read -r -p "  Supabase anon key: " KEY
[ -n "$URL" ] && [ -n "$KEY" ] || die "Need both a project URL and an anon key (Supabase → Settings → API)."

# --- 3. schema ---------------------------------------------------------------
if [ "$SKIP_SCHEMA" -eq 0 ]; then
  step "Database schema"
  echo "  This is the one step that has to happen in the browser — creating tables"
  echo "  needs dashboard access that the anon key doesn't have."
  echo
  if command -v pbcopy >/dev/null 2>&1; then
    pbcopy < backend/schema.sql
    ok "schema.sql copied to your clipboard"
  else
    echo "  ${DIM}Copy the contents of: $(pwd)/backend/schema.sql${OFF}"
  fi
  echo "  1. Open ${URL/https:\/\//https://supabase.com/dashboard/project/} → SQL Editor → New query"
  echo "  2. Paste, hit Run"
  echo "  3. Authentication → Users → Add user (tick Auto Confirm User)"
  echo
  read -r -p "  Press Enter once that's done (or Ctrl-C to bail) "
fi

# --- 4. login ----------------------------------------------------------------
step "Signing you in"

EMAIL="${FONTSYNC_EMAIL:-}"
PASSWORD="${FONTSYNC_PASSWORD:-}"
[ -n "$EMAIL" ] || read -r -p "  Email: " EMAIL
if [ -z "$PASSWORD" ]; then read -r -s -p "  Password: " PASSWORD; echo; fi

# --- 5. verify the backend before trusting it --------------------------------
step "Testing the backend"

if SUPABASE_URL="$URL" SUPABASE_ANON_KEY="$KEY" FONTSYNC_EMAIL="$EMAIL" FONTSYNC_PASSWORD="$PASSWORD" \
     node backend/test-backend.mjs; then
  ok "Backend works end to end"
else
  die "Backend test failed — see above. Fix that before going further; nothing downstream will work."
fi

# --- 6. save config + session ------------------------------------------------
step "Saving your settings"

mkdir -p "$(dirname "$CONFIG_FILE")"
chmod 700 "$(dirname "$CONFIG_FILE")"
URL="$URL" KEY="$KEY" CONFIG_FILE="$CONFIG_FILE" node -e '
  const fs = require("fs");
  const file = process.env.CONFIG_FILE;
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  fs.writeFileSync(file, JSON.stringify({ ...existing, supabaseUrl: process.env.URL, supabaseAnonKey: process.env.KEY }, null, 2), { mode: 0o600 });
'
ok "Wrote $CONFIG_FILE"

node watcher/bin/signin.js "$EMAIL" "$PASSWORD" || die "Could not store your session."

# --- 7. done -----------------------------------------------------------------
step "Next: the Figma plugin"
echo "  Figma desktop app → Plugins → Development → Import plugin from manifest…"
echo "  ${BOLD}$(pwd)/figma-plugin/manifest.json${OFF}"
echo "  ${DIM}(the browser version of Figma can't load local plugins)${OFF}"

if [ "$START" -eq 1 ]; then
  step "Starting Font Watcher"
  echo "  Settings UI: http://localhost:7331   ${DIM}Ctrl-C to stop${OFF}"
  echo "  Install a font and it'll show up there within a couple of seconds."
  echo
  exec node watcher/bin/fontsync.js
else
  step "Done"
  echo "  Start the watcher with: ${BOLD}node watcher/bin/fontsync.js${OFF}"
fi
