#!/usr/bin/env bash
# deploy-from-laptop.sh — push the laptop's main and trigger a rebuild on
# the Mac mini server. Invoked via `npm run deploy:mini`.

set -euo pipefail

MINI_HOST="${AGENT_FACTORY_MINI_HOST:-100.110.160.8}"   # override with env var
MINI_USER="${AGENT_FACTORY_MINI_USER:-samdavila}"
MINI_REPO="${AGENT_FACTORY_MINI_REPO:-/Users/samdavila/Projects/agent-factory}"

log() { printf '\033[36m[deploy:mini]\033[0m %s\n' "$*"; }

# --- push ---
log "git push origin main"
git push origin main

# --- remote rebuild ---
log "ssh $MINI_USER@$MINI_HOST → run deploy-mini.sh"
ssh -o StrictHostKeyChecking=accept-new "$MINI_USER@$MINI_HOST" \
  "bash -lc 'cd $MINI_REPO && ./scripts/deploy-mini.sh'"

log "Done. Tail mini logs with:"
log "  ssh $MINI_USER@$MINI_HOST 'tail -F ~/Library/Logs/agent-factory/stdout.log ~/Library/Logs/agent-factory/stderr.log'"
