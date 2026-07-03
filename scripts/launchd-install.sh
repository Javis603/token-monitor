#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.javis.tokenmonitor"
PLIST_NAME="${LABEL}.plist"
LAUNCHER="$ROOT/scripts/launch-token-monitor.sh"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$AGENTS_DIR/$PLIST_NAME"
LOG_DIR="$HOME/Library/Logs/Token Monitor"
UID_NUM="$(id -u)"
DOMAIN="gui/${UID_NUM}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "launchd install is macOS only." >&2
  exit 1
fi

chmod +x "$LAUNCHER"
mkdir -p "$LOG_DIR" "$AGENTS_DIR"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${LAUNCHER}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${ROOT}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/launchd.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

if launchctl print "${DOMAIN}/${LABEL}" >/dev/null 2>&1; then
  launchctl bootout "${DOMAIN}" "$PLIST_PATH" >/dev/null 2>&1 || true
fi

launchctl bootstrap "${DOMAIN}" "$PLIST_PATH"
launchctl enable "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true
launchctl kickstart -k "${DOMAIN}/${LABEL}" >/dev/null 2>&1 || true

echo "Installed LaunchAgent: ${PLIST_PATH}"
echo "Logs: ${LOG_DIR}/launchd.{out,err}.log"
echo "Status: launchctl print ${DOMAIN}/${LABEL}"
