#!/bin/bash
set -euo pipefail

LABEL="com.javis.tokenmonitor"
PLIST_NAME="${LABEL}.plist"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$AGENTS_DIR/$PLIST_NAME"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd uninstall is macOS only." >&2
  exit 1
fi

if [[ -f "$PLIST_PATH" ]]; then
  launchctl bootout "${DOMAIN}" "$PLIST_PATH" >/dev/null 2>&1 || true
  rm -f "$PLIST_PATH"
  echo "Removed LaunchAgent: ${PLIST_PATH}"
else
  echo "LaunchAgent not installed: ${PLIST_PATH}"
fi
