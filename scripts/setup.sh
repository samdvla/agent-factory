#!/usr/bin/env bash
# setup.sh — one-time setup for a fresh clone.
#
# Installs the frontend dependencies and creates each Python worker's
# uv-managed virtualenv (workers/<name>/.venv). The app spawns every
# worker through its own .venv, so this must run once before the first
# `npm run tauri dev`.
#
# Re-running is safe — npm install and uv sync are both idempotent.
#
# Usage:
#   bash scripts/setup.sh

set -euo pipefail
cd "$(dirname "$0")/.."

log() { printf '\033[36m[setup]\033[0m %s\n' "$*"; }

# --- frontend deps ---
log "npm install"
npm install

# --- per-worker virtualenvs via uv ---
if ! command -v uv >/dev/null 2>&1; then
  echo "[setup] ERROR: 'uv' is not installed. Get it at https://docs.astral.sh/uv/" >&2
  exit 1
fi

for d in workers/*/; do
  if [ -f "$d/pyproject.toml" ]; then
    log "uv sync — $d"
    ( cd "$d" && uv sync --quiet )
  fi
done

log "Done. Start the app with:  npm run tauri dev"
