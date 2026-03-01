#!/usr/bin/env bash
# .ai/hooks/dispatch-bridge.sh
# Non-interactive nvm bootstrap + dispatch.
# Called by run-hook.cmd. Never use -i to avoid shell noise on stdout.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SCRIPT_DIR/dispatch.mjs" "$@"
