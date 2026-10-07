# Cloud sessions in the existing Sessions view

Cloud is a session source, not a separate application view. Local Codex, hosted Codex, dot tasks and subagents appear together in the existing **Sessions / 会话** list, using its renderer, recency sorting, pagination, keyboard behavior and detail surface. There is no Cloud footer button or Cloud dashboard tab. The ordinary dashboard retains Overview and Trends.

`cloudSessionRows.js` adapts the current account-checked observer snapshot to the existing session row shape. Cloud-only rows keep the Codex tool identity and add a small **Cloud / 云端** source label and **Lifetime · cloud / 累计 · 云端** metric label. They do not fabricate a model name, session title, request count, generation speed or price. A missing token counter remains unavailable. The normal row's detail opens the observed numeric breakdown, last observation/activity time, engine-parent and delegation-parent identities, and connection gaps; it does not request a local transcript for a cloud-only session.

An exact canonical Codex thread UUID shared by a local and cloud record produces one local row labeled **Local + cloud / 本地 + 云端**, with cloud observations appended to its detail. The local row's period values, title and cost remain unchanged. UUID-looking fragments inside a rollout filename or title are not enough to identify a duplicate. Other tools never collapse into Codex merely because their IDs match.

## Counting, dates and privacy

This is presentation integration, not a change to the collector's aggregation. The source provides cumulative engine counters. Cached input is included in input and reasoning output is included in output. Cloud values are not added to existing DAY/MONTH/TOTAL, model/project/cost charts, device ingestion or public Hub totals, and parent/child counters are not summed while overlap is unknown. Cloud rows do not influence local period bar scales.

DAY and MONTH select cloud sessions by source activity time (creation time only when activity is unavailable), not by the time an old token snapshot was replayed. Their visible values remain explicitly cumulative. TOTAL can include undated cloud rows; unsupported derived ranges retain the existing session-availability gate. No historical period usage is inferred from a lifetime value.

The main-process bridge still uses a fixed report path, size and row limits, token validation, account-scope checking before/after a read, and a field allowlist. Credentials, scope fingerprints, private paths and raw messages never enter the renderer. Sender checks require an owned top-frame bundled renderer. Stopped/expired observations are not marked live; a mismatched login clears cloud rows and detail data. Installation-retained values keep their earlier timestamps and are labeled as prior observations, not new consumption.

The UI reads this bridge serially while Sessions or Settings is visible. It does not open cloud connections or launch a second watcher. The background automatic discovery/event capture service remains unchanged. Its toggle now lives under **Settings → General → Integrations → Automatically monitor Codex cloud sessions**, not in a cloud-only screen. Closing the application does not stop the independent user service; disabling the toggle does. Legacy `cloudUsage:open` IPC and `--cloud-usage` command arguments navigate to Sessions for compatibility; `--sessions` does the same.

## Service availability

The Settings toggle controls the existing macOS user LaunchAgent `local.chengong.tokenmonitor.cloudauto`; it does not install a service or launch another observer. It is disabled when that service is absent or on unsupported platforms. The standalone foreground observer remains available through `npm run codex:usage:auto -- --acknowledge-auto-attach`. Early local/account usage tools, test-app deployment, local packaging and update-policy overrides are outside this upstream proposal. This source change does not install the corrected UI on an offline Mac.

## Verification

```sh
node --test tests/electron/cloudSessionRows.test.js \
  tests/electron/sessionRows.test.js tests/electron/cloudUsageIntegration.test.js
TM_SESSIONS_VERIFY_DIR=/absolute/private/test-directory \
  node_modules/.bin/electron scripts/verify-unified-sessions.js
npm run verify
```

The UI smoke harness uses the actual main-window HTML, preload and renderer, with entirely synthetic session/stats responses. It checks mixed local/cloud rows, unchanged local header totals, live row updates, source activity period selection, the shared detail screen, absence of local transcript reads for cloud-only sessions, and the Settings toggle. It creates no cloud connection or model turn.

The screenshot in `docs/images/codex-unified-sessions.png` uses illustrative fixture data. It is UI evidence, not a new real-account token measurement. Prior cloud-engine and automatic-discovery experiments are recorded separately; they do not validate installation of this corrected UI on a disconnected device.
