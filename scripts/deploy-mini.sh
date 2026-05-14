#!/usr/bin/env bash
# deploy-mini.sh — runs ON the Mac mini. Pulls the latest code, rebuilds,
# reinstalls the .app, and kickstarts the LaunchAgent. Triggered remotely by
# scripts/deploy-from-laptop.sh after `git push`.
#
# Idempotent: re-running with no upstream changes is a no-op.

set -euo pipefail

REPO_DIR="$HOME/Projects/agent-factory"
APP_NAME="agent-factory.app"
APP_DEST="/Applications/$APP_NAME"
LABEL="com.agentfactory.headless"
PLIST_SRC="$REPO_DIR/scripts/$LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/agent-factory"

log() { printf '\033[36m[deploy]\033[0m %s\n' "$*"; }

cd "$REPO_DIR"

# Make sure Homebrew is on PATH (launchd PATH is minimal)
if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# --- pull ---
log "git fetch + reset to origin/main"
git fetch origin
git reset --hard origin/main

# --- frontend deps (only if package files changed in the pull) ---
if git diff --quiet HEAD@{1} HEAD -- package.json package-lock.json 2>/dev/null; then
  log "npm deps unchanged, skipping install"
else
  log "package files changed, running npm install"
  npm install
fi

# --- worker venvs (only the ones whose pyproject changed) ---
for d in workers/*/; do
  if [ -f "$d/pyproject.toml" ]; then
    if git diff --quiet HEAD@{1} HEAD -- "$d/pyproject.toml" "$d/uv.lock" 2>/dev/null; then
      :
    else
      log "uv sync in $d (deps changed)"
      ( cd "$d" && uv sync )
    fi
  fi
done

# --- build the Tauri .app ---
log "cargo tauri build (release)"
npm run tauri -- build

# --- install / replace .app ---
BUILT_APP="$REPO_DIR/src-tauri/target/release/bundle/macos/$APP_NAME"
if [ ! -d "$BUILT_APP" ]; then
  echo "deploy-mini: build did not produce $BUILT_APP" >&2
  exit 1
fi
log "Replacing $APP_DEST"
rm -rf "$APP_DEST"
cp -R "$BUILT_APP" "$APP_DEST"
# Strip the quarantine xattr so launchd / Gatekeeper doesn't block it.
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

# --- LaunchAgent plist ---
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
if [ -f "$PLIST_SRC" ]; then
  log "Installing LaunchAgent plist → $PLIST_DEST"
  cp "$PLIST_SRC" "$PLIST_DEST"
fi

# --- (re)load the agent ---
DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  log "kickstart -k $DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
else
  log "bootstrap $DOMAIN $PLIST_DEST"
  launchctl bootstrap "$DOMAIN" "$PLIST_DEST"
fi

log "Deploy complete. Tail logs with:"
log "  tail -F $LOG_DIR/stdout.log $LOG_DIR/stderr.log"
