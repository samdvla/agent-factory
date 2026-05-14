#!/usr/bin/env bash
# bootstrap-mini.sh — run ONCE on a fresh Mac mini to install all
# dependencies, clone the repo, and prep the headless server.
# Idempotent: safe to re-run; each step skips if already done.
#
# Usage (from the laptop):
#   ssh samdavila@100.110.160.8 'bash -s' < scripts/bootstrap-mini.sh
# Or, if already on the mini:
#   ./scripts/bootstrap-mini.sh

set -euo pipefail

REPO_URL="https://github.com/samdvla/agent-factory.git"
REPO_DIR="$HOME/Projects/agent-factory"
BREW_BIN="/opt/homebrew/bin/brew"

log() { printf '\033[36m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[bootstrap]\033[0m %s\n' "$*"; }

# --- Xcode CLI tools ---
if xcode-select -p >/dev/null 2>&1; then
  log "Xcode CLI tools already installed"
else
  log "Installing Xcode CLI tools (this opens a GUI dialog; accept it)"
  xcode-select --install || true
  warn "Re-run this script once the Xcode install finishes."
  exit 0
fi

# --- Homebrew (arm64) ---
if [ -x "$BREW_BIN" ]; then
  log "Homebrew already installed"
else
  log "Installing Homebrew (arm64)"
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$($BREW_BIN shellenv)"

# --- brew packages ---
PKGS=(node python@3.11 rust ffmpeg uv git)
for p in "${PKGS[@]}"; do
  if brew list --formula "$p" >/dev/null 2>&1; then
    log "brew $p already installed"
  else
    log "brew install $p"
    brew install "$p"
  fi
done
brew link --overwrite --force python@3.11 || true

# --- clone repo ---
if [ -d "$REPO_DIR/.git" ]; then
  log "Repo already cloned at $REPO_DIR"
else
  log "Cloning $REPO_URL → $REPO_DIR"
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone "$REPO_URL" "$REPO_DIR"
fi

cd "$REPO_DIR"

# --- frontend deps ---
log "npm install"
npm install

# --- worker venvs via uv ---
for d in workers/*/; do
  if [ -f "$d/pyproject.toml" ]; then
    log "uv sync in $d"
    ( cd "$d" && uv sync )
  fi
done

# --- log + app-support dirs ---
mkdir -p "$HOME/Library/Logs/agent-factory"
mkdir -p "$HOME/Library/Application Support/com.agentfactory.app"
mkdir -p "$HOME/Library/LaunchAgents"

# --- fetch Rust deps so the first build is faster ---
log "cargo fetch (warming the registry)"
( cd src-tauri && cargo fetch )

log "Bootstrap complete."
log "Next: scp the secrets db.sqlite over from the laptop, then run ./scripts/deploy-mini.sh"
