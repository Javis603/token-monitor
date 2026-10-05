# Desktop entry for cloud token capture

The existing single-thread engine observer now has a macOS desktop wrapper. This is a usability/deployment change, not a new archive, automatic account-wide scanner, reconnection service or historical token source. The local ledger, cloud history/credits reader and production collector remain separate.

## User entry

After deployment, double-click `~/Applications/云端实时Token监听.command`. The native dialog asks for a real hosted engine thread UUID and explains that the next 60 seconds will be observed. Cancel exits without reading a login or starting the observer. Invalid identifiers fail before a process is started. Supply the ID before or while the selected task executes; an idle completed task may produce no token event.

For an explicit command-line invocation:

```sh
node scripts/codex-cloud-capture-desktop.js --thread ENGINE_THREAD_UUID --seconds 60
```

The `--headless` option requires a thread argument and suppresses both the dialog and browser opening. Duration is bounded to 1–120 seconds. The wrapper launches the existing `codex-cloud-engine-usage.js` with explicit attachment, private event, JSON and HTML destinations; it does not add a credential reader, prompt, discovery query, subscription protocol variant or billing query.

Each invocation creates a fresh directory under `~/Library/Application Support/Token Monitor Usage Test/reports/engine-capture-*/`. It contains `events.jsonl`, `report.json`, `report.html`, a private `capture.log`, and a `capture.json` lifecycle receipt. The receipt distinguishes observed, ambiguous, no-notification, failed and timeout states. No-notification is unknown, never zero. These are independent observation files, not a merged historical ledger. Simultaneous invocations do not share a mutable latest-run file or add their totals together.

When capture finishes, the wrapper opens only the HTML from its own successfully identity-checked report. Browser-opening failure does not erase a successful capture. A separate child process group avoids double-delivery when Terminal and the wrapper both receive Ctrl+C. Only the observer process is signalled; the user's cloud model task is not interrupted. An outer bounded watchdog terminates an observer that fails to exit. The UI wrapper is not an autostart daemon.

## Deployment and rollback

```sh
python3 -B scripts/deploy-codex-capture-entry.py
python3 -B scripts/deploy-codex-capture-entry.py --apply
```

The default command is a dry-run. The apply command accepts only the existing parallel `Token Monitor Usage Test.app`, checks its bundle identity and every previous manifest hash, and requires a clean committed source checkout. Production `Token Monitor.app` is rejected. Unmanifested user files or an existing shortcut require reconciliation instead of silent overwrite.

The observer is a subprocess entry rather than a `require()` dependency; the installer therefore includes it explicitly when computing the module closure. Existing source, runtime and license files are refreshed from the tested checkout without downloading dependencies. A complete backup precedes the atomic Resources replacement. Failed staging or a concurrent shortcut collision restores old resources and preserves the other shortcut. No login files, original widget database, global model configuration or user reports are bundled.

Backups and an upgrade receipt are stored under the parallel app's private data directory `backups/before-desktop-capture-*/`. The original app launcher still retains its previous default behavior; the new specifically named shortcut is the live token entry. No files in `/Applications/Token Monitor.app` are modified by this installer.

## Verification

```sh
node --test tests/scripts/codexCaptureDeploy.test.js tests/scripts/codexCloudCaptureDesktop.test.js
npm run verify
```

The new tests use synthetic subprocess results and temporary fixture repositories only; they do not connect to an account or generate model usage. They cover explicit selection, cancellation, process arguments, separate output directories, unknown counters, wrong-thread rejection, private permissions, symlinks, malformed reports, browser failure, dependency packaging, source conflicts, production protection and rollback collisions.

Real engine counts were established in the earlier separate-connection experiment; the desktop tests do not recreate that model execution or claim historical coverage. The current observer continues to use the known live-event path. Automatic child discovery, unattended reconnection, cross-connection reconciliation, historical backfill and reliable parent/child sum remain outside this desktop wrapper.

## Device acceptance, 2026-10-05

The desktop source was committed as `f07ce71706c85a89283ad7f56e70db2c4e8cb0d4` and installed into the existing parallel test app after verification and backup. All 236 packaged source/runtime/license hashes matched. The new shortcut's help entry executed from the deployed location, and the actual native dialog text compiled with AppleScript without displaying a prompt during automated checks.

The packaged shortcut performed one real one-second observation against the previously selected existing cloud task. Viewer attachment succeeded, output JSON/HTML and the lifecycle receipt were produced, and the process exited normally after approximately 14 seconds including connection and detachment overhead. The idle sample produced no new token notification; the report retained null with `no-usage-notification`. The observer audit recorded zero model-turn starts. This verifies packaged attachment and output handling, not a new positive live token sample.

The deployed counting module was independently checked against the previously saved real two-connection evidence: the normalized input/output/total matched the saved execution connection, including the earlier 9,099 total. That was replayed prior evidence, not new cloud execution or newly incurred test usage.

The new wrapper/installer suite passed 19 tests. The full repository `npm run verify` passed lint plus 5,888 tests, with two skips and zero failures (5,890 total). Tests used temporary repositories and synthetic subprocess reports; they do not count as cloud-service verification. The live check above is recorded separately in private task-notes `capture-desktop-acceptance.json`.

The production Token Monitor application, Codex global routing and account credentials were not changed by these deployment commands. The new archive, automatic task/child discovery, sustained reconnect and historical backfill were not implemented as part of this desktop-entry change. The existing app's default click behavior remains the older account report; use the explicitly named new shortcut for live engine counts.
