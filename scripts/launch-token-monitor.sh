#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
unset ELECTRON_RUN_AS_NODE

if [[ -n "${TOKEN_MONITOR_APP:-}" && -d "$TOKEN_MONITOR_APP" ]]; then
  exec open -a "$TOKEN_MONITOR_APP" --args --hidden
fi

if [[ -x "$ROOT/node_modules/.bin/electron" ]]; then
  exec "$ROOT/node_modules/.bin/electron" .
fi

exec npm start
