# Native Token Monitor cloud integration

The main Token Monitor application now exposes the existing automatic cloud observer in its native UI. This is not an iframe, external HTML launcher, a second observer, or a new source of billable estimates. The main widget's **Cloud / 云端** button opens the native Usage Dashboard's **Codex Cloud / Codex 云端** tab. The tab contains service state, discovered/listening/measured counts, thread relationships, per-thread input/cache/output/cumulative tokens, timestamps, gaps, search, filters and service controls.

## Data and process boundary

`src/electron/cloudUsageBridge.js` runs in the Electron main process. It reads only the existing fixed observer report, bounds file size and row count, validates numeric fields and IDs, verifies account scope before/after reading, and returns a field allowlist. Authentication material and scope fingerprints never enter the renderer. New IPC handlers verify the requesting top frame belongs to this application's bundled main or dashboard renderer. No generic path reader, command executor or arbitrary URL is exposed.

The renderer polls its IPC bridge every three seconds while the cloud tab is active, coalesces overlapping reads and skips hidden-window reads. It never opens a cloud WebSocket itself. The observer remains the one launchd service `local.chengong.tokenmonitor.cloudauto`, so a second window or repeat click does not create another watcher. Start/stop controls affect this registered observer only, not a user's cloud task. Closing Token Monitor does not stop the independent user service; the explicit Stop monitoring control does.

The existing observer continues to discover running cloud threads and record actual engine events. This integration does not rewrite its collection algorithm or local Tokscale collection. Cumulative cloud values are deliberately absent from existing local DAY/MONTH/TOTAL, cost, heatmap, device ingestion and public Hub totals. Parent/child coverage remains unknown, so the UI never sums all cloud rows or converts allowance/credits into tokens.

## Freshness and account identity

A report older than 30 seconds, a stopped service, or a non-listening observation state is visibly stale. Old valid counts can remain visible, but their thread rows are no longer marked live. A report from another Codex login is hidden entirely. Unknown counts remain null rather than zero. Malformed or ambiguous counters do not become measured values.

Installing the integrated application restarts the observer once to move its executable into the main application. Before restart, the installer retains one numeric report as `native-previous-report.json`. The native bridge may show an exact-thread, same-account prior count only when the new run has not yet received a count for that thread. Such rows are explicitly marked **Saved before service restart / 重启前留存计数** with their original timestamps. A current value or an ambiguous current counter always wins. This is a last-known display fallback, not a merged request archive or a cross-run additive total.

## Local application build

```sh
npm run verify
npm run ensure:tokscale -- --platform=darwin-arm64
CSC_IDENTITY_AUTO_DISCOVERY=false node_modules/.bin/electron-builder \
  --config scripts/electron-builder.cloud-local.config.js \
  --mac --arm64 --dir --publish never
python3 -B scripts/install-cloud-native.py
python3 -B scripts/install-cloud-native.py --apply
```

The local build is identified as `0.66.0-cloud.1`; it is not an official upstream release. It uses the already installed Electron runtime and the existing dependencies, copies the observer source/runtime/licenses with a standard post-pack hook while preserving the main archive, and uses a local ad-hoc signature. No Apple Developer ID or notarized distribution is claimed. This local build disables its background upstream update checks through build metadata, without rewriting the user's automatic-update setting. Regular upstream builds retain their existing behavior.

The installer validates the new application identity and signature, verifies the packaged observer source against the checkout, and requires a clean committed source. It copies the old application, launcher plist and applicable settings files into a private rollback backup before changing anything. It stops only the existing main application gracefully, replaces the application, and points the same user launchd label at `Token Monitor.app/Contents/Resources/cloud-observer/scripts/codex-cloud-auto-watch.js`. The existing data directory and event runs are preserved. A failure restores the original app/service instead of leaving duplicate monitors. No Codex routing or credential file is modified.

The older parallel test app is retained as a backup/development artifact but is no longer the service runtime dependency after successful migration. Existing start/stop/view shortcuts refer to the same service and data, so they do not spawn an additional observer.

## Verification

```sh
node --test tests/electron/cloudUsageIntegration.test.js tests/electron/dashboardWindow.test.js
TM_CLOUD_VERIFY_DIR=/absolute/private/test-directory \
  node_modules/.bin/electron scripts/verify-cloud-dashboard.js
```

The native smoke harness runs the actual dashboard, preload and guarded IPC against the real local observer report, while supplying only unrelated appearance/history test settings. It verifies visibility, selected Cloud tab, live rows and the measured filter, then captures the native window. It does not create model turns. The field-validation tests use synthetic reports and mock launchctl behavior separately.

Source verification completed with lint and 5,943 passing tests, two skipped, zero failed (5,945 total). The native Electron smoke check displayed 68 discovered rows and five measured rows at the observation time. Counts are dynamic and these figures are acceptance evidence, not an account-wide completeness assertion. Packaging, installed-application launch and service migration must be recorded separately after they actually complete.

## Installed application acceptance — 2026-10-05

The integrated main application is installed at `/Applications/Token Monitor.app` as `0.66.0-cloud.1` and was reopened without inspection flags after testing. The code in the successful package corresponds to `b561c01213d2df03692a8bf3e6fa9554fab3242f`; subsequent source changes in this phase are packaging regression tests and this verification record.

Actual installed-app testing opened the normal widget and clicked its native Cloud button, not an external report link. The installed dashboard selected Codex Cloud and displayed the existing service's 68 discovered threads; filtering selected five measured rows. The Start control succeeded without changing the running observer PID, demonstrating idempotent reuse rather than duplicate capture. The data was the real local service projection, not a synthetic fixture. The service points at the bundled observer inside the main application, and the old parallel app is no longer its runtime dependency.

The necessary service restart preserved the last-known values from the earlier run. At final acceptance the five measured rows were explicitly marked as retained pre-restart observations; no new live token event was claimed for them. The service was running, discovery was current, and no task was actively listened to at that final instant. The native UI did not sum these retained values into local totals. This turn created no new model task.

Initial packaging inspection exposed a real error: `extraResources` rules for `src/shared` caused electron-builder to exclude that directory from `app.asar`. The old application backup and observer records were retained, the build was corrected to use an afterPack copy, and 350 main/shared/Hub JavaScript/JSON files were verified present in the corrected archive. A dedicated packaging regression now preserves the archive while checking the standalone observer's script, modules and licenses. A separate launchd migration race was corrected with bounded unload/load checks and rollback restoration; no service permission was bypassed.

Final source verification passed lint and 5,946 tests with two skips, zero failures (5,948 total). Native-window testing used the actual installed asar/preload/guarded IPC, exercised the widget entry, measured-row filter and idempotent service start, and captured a screenshot. The transparent screenshot was separately composited on the dark app backdrop for visual inspection; the native capture itself was retained. Temporary renderer/main inspection ports were both confirmed closed, and the app was relaunched normally. The cloud observer remained running.

Private installation, screenshot and lifecycle evidence is saved outside the repository in the existing task-notes directory. The valid original 0.65.0 backup is retained under `~/Library/Application Support/Token Monitor Cloud Integration/backups/before-native-51whifdy/Token Monitor.app`; the final migration also created a backup of the immediately preceding local build. User data and prior cloud event runs remain in their original directory. No upstream GitHub release, push, pull-request merge, Developer ID signature or notarization is claimed.
