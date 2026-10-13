# Cloud observation acceptance boundaries

The source contains synthetic regressions for account-isolated observation, cumulative accounting, conservative local/cloud identity reconciliation, parent overlap, storage failures, guarded stale-lock recovery, and renderer account/control races. `scripts/verify-unified-sessions.js` exercises the actual Electron preload and renderer with synthetic stats and no cloud connection or model request.

Real-account capture, macOS LaunchAgent failure/restart behavior, installed-app migration, signed/notarized builds and Windows service support need separate acceptance. Historical local installation reports are excluded from this upstream proposal because they contain machine-specific metadata and are not evidence for the current candidate.
