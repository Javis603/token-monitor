#!/bin/bash
set -euo pipefail

LABEL="com.javis.tokenmonitor"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if [[ ! -f "$PLIST_PATH" ]]; then
  echo "Not installed: ${PLIST_PATH}"
  exit 1
fi

echo "Plist: ${PLIST_PATH}"
launchctl print "${DOMAIN}/${LABEL}" 2>/dev/null || {
  echo "Registered plist exists but job is not loaded."
  exit 1
}
