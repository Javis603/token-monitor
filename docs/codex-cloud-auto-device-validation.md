# Automatic cloud watcher: device acceptance

Verified on 2026-10-05 Asia/Shanghai. Runtime/package source commit: `8af4d63696b5363625dc287c3f5b02e672e68ec8`. The parallel test app has 238 verified source/runtime/license files. The user LaunchAgent `local.chengong.tokenmonitor.cloudauto` is loaded and running; its command contains no manually supplied thread ID. Login startup is configured but a physical logout/reboot was not performed as part of validation.

## Actual automatic discovery and positive counting

A bounded first run independently discovered 66 hosted threads. Without supplying any UUID, it attached to an existing active task and recorded four real engine-usage events. The final per-thread counter exactly matched the latest persisted event and input plus output matched total. This was not a new test task, a billing estimate, a fixture replay or a scan of local rollout logs. Private identifiers and cumulative values are retained outside the repository in the first run's acceptance file.

The deployed persistent service subsequently discovered a newly created isolated verification task without being told its UUID. Automatic viewer attachment was visible approximately 5.227 seconds after thread creation, before that task's model request was started. One short verification reply was then submitted by the separate test connection. The automatic listener and the execution connection reported identical input, output, cached-input, reasoning and total counters. The task completed and was archived. Exactly one test model turn was submitted by the test driver; the observer has no model-start capability. Its real cost is explicitly separated from passive monitoring of existing tasks.

The persistent service also recorded an actual `aeon` root's cumulative usage while that root executed. This establishes positive automatic observation of a dot-style root, not only the isolated test. Its own cumulative count is not added to children or converted to a bill. Parent-child overlap and complete historical coverage remain unknown.

## Reconnection and deployment

A separate bounded test deliberately closed only the observer's socket after startup. The loop created a second authenticated connection, rediscovered the catalog and reattached without a UUID supplied by the caller. No token event occurred in that short reconnection test; counter continuity and duplicate-snapshot handling across reconnection are therefore covered by the synthetic regression, not claimed as an additional real positive event. No cloud task was interrupted by the simulated observer disconnection.

The launch-agent start shortcut was run twice. The live PID remained unchanged, and the directory process lock prevented a duplicate instance. The view shortcut opened the local report. A temporary-profile headless browser rendered the real report and the image was inspected; its capture process exited afterward. The current service remained running for the user.

The installer preserved a complete parallel-app backup and refused conflicts before replacement. It added dedicated start, stop and view shortcuts; it did not overwrite the original Token Monitor app, route settings, credentials or old observation files. The data directory contains independent per-process runs, not a merged lifetime account ledger. Cross-process consolidation is still separate work.

## Test results

Thirty-five new focused tests passed. A complete `npm run verify` passed lint and 5,923 tests with two skips, zero failures (5,925 total). One intermediate repeat stalled in an existing Worker gzip-negotiation test after the new suites had passed; only that owned test child was terminated, and a bounded full rerun passed. No user application process was terminated for testing.

New regressions first failed and then passed for loss of cached delegation metadata, both directory variants failing without reconnect, and stale active status after reconnect. Other tests cover default/filtered union, archived sources, subagent edges, new tasks, listener capacity, early events, privacy, scope changes, process singleton behavior, file limits, graceful shutdown and safe deployment.

Private field-minimized evidence is in `token-monitor-task-notes/automatic-cloud-final-acceptance.json` and its referenced local receipts. No transcript body, authentication value or raw error body is committed. Automatic discovery/listening is verified; sleeping/offline periods, very short tasks, hidden or refused threads, capacity/page limits, historical backfill and parent-child summed billing are not silently marked complete.
