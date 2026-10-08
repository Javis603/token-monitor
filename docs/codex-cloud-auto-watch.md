# Automatic hosted-cloud discovery and token listening

This opt-in service removes the need to enter a thread UUID. It discovers the current hosted catalog, attaches a viewer to running threads and recently created warm threads, and records actual engine token notifications. It uses the existing fixed-origin cloud transport, not a billing endpoint, guessed task ID, browser cookie or model-generated estimate. The original Token Monitor collector and its totals are unchanged.

## Start, stop, view

The Sessions integration exposes a Settings toggle for an already installed macOS user LaunchAgent, `local.chengong.tokenmonitor.cloudauto`. It is disabled when the service is absent or unsupported. Closing the widget leaves the independent service running; disabling the toggle stops it. This proposal does not automatically install a LaunchAgent, modify an application bundle or enable monitoring on first launch.

A foreground alternative is:

The on-disk foreground observer currently requires Linux/macOS POSIX ownership and private-mode checks. Windows ACL-backed observer storage is not implemented: its ordinary writable-directory mode is refused, and existing lock evidence is preserved. Windows CI still exercises the cloud row adapter, account/privacy bridge and injected-sink monitoring loop; passing those checks does not establish a working Windows capture service.

```sh
node scripts/codex-cloud-auto-watch.js --acknowledge-auto-attach
```

Options include `--interval` (default 5 seconds, minimum 2), `--max-listening` (default 32, maximum 128), `--pages` (default 3 per catalog variant), `--seconds` for a finite run, and `--data-dir`. Help does not read authentication. No manual `--thread` argument exists. The acknowledgment is required because viewer attachment can load a cloud runtime or its MCP environment even though it never sends a model turn or changes settings.

## What is automatically discovered

Each serial scan unions unfiltered and explicitly source-filtered active catalog pages. Null-source cloud/aeon entries can be missing from explicit source filtering, so neither query replaces the other. Archived catalog variants are checked every five minutes. Pagination, known-thread count, listener capacity and request sizes are bounded and coverage is explicit. The watcher carries over actual engine-parent IDs and separately account/user-matched cached delegation-parent IDs. It does not infer a dot identity from a title or working directory.

Threads with live `status.type = active` are candidates regardless of user/aeon/subagent classification. Newly created warm idle threads are observed for a short window so a following turn can be captured. Old `notLoaded` history is not automatically loaded. Idle listeners are retained for a grace period to collect tail events. If hosted unsubscribe is unavailable, the watcher closes its own connection and reattaches the remaining candidates instead of sending a task stop.

A single authenticated WebSocket carries discovery and multiple subscriptions. Exact thread IDs are deduplicated and registered before awaiting the resume response, so early usage events are not lost. The observer RPC allowlist rejects thread/model starts, interrupts, deletion, archival, permission changes and resume configuration overrides. This watcher does not call the shared transport's optional billing or quota methods. The only viewer attachment is `thread/resume` with the exact ID and `excludeTurns: true`. It does not request message-history payloads.

## Reconnect, scope and accounting

The monitor reconnects after disconnection, with exponential backoff capped at 60 seconds. A capture/storage or account-scope failure is fatal, including a notification received during the polling sleep. The loop checks the saved error before replacing a closed connection and never reconnects after that failure. Shutdown preserves the original fatal code even if publishing the final snapshot or closing resources fails; those failures are reported separately, and the CLI exits unsuccessfully. A successful metadata heartbeat renews a bounded connection lease; failed discovery does not masquerade as a successful heartbeat. New connections discard stale runtime-status assumptions and rediscover before attaching. Previously received counters remain in memory for the same process and account scope, with reconnection gaps explicitly counted. Repeated cumulative values are not added together.

Authentication is handled by the existing repository helper. The file/identity is verified before each numeric event is passed to storage. A credential refresh can reconnect within the same account/user fingerprint. A different fingerprint pauses the service rather than combining two accounts. Token material and conversation text are never copied to the report, log or package. Authentication is read by the service process, never supplied by the renderer.

Each thread's latest engine cumulative value is displayed separately. Cached input is contained in input; reasoning output is contained in output. Invalid counters or decreases are ambiguous. Parent totals may overlap children, and a fork may inherit earlier history: this service therefore emits no combined task/account token sum, and the report itself is never summed blindly. The Token Monitor app consumes this report through the separate account ledger (`cloud-ledger.json` in the same directory), which applies the first-snapshot TOTAL-only baseline, idempotent observation-dated increments, local-thread deduplication and the conservative parent/child overlap exclusion described in [the native integration note](../codex-cloud-native-integration.md). Billing estimates still never include these counters.

## Files and resource bounds

The default data directory is `~/Library/Application Support/Token Monitor Usage Test/auto-cloud/`. `report.json` and `report.html` describe the current observation run. The HTML refreshes itself every five seconds, but its timestamp must be checked: an abruptly stopped process cannot update an old file to say stopped.

Each process run keeps a separate private `runs/<run-id>/events.ndjson` and `report.json`. Valid numeric records are fsynced when received. These run files survive a process restart, but the new run does not silently reconstruct or add all earlier totals. Cross-process history consolidation is not implemented here. Within one process, reconnects retain latest per-thread counters and deduplicate repeated snapshots.

An exclusive process lock prevents two watcher instances from writing the same directory. Owner records bind a nonce and PID to a process start identity: Linux uses the boot UUID and `/proc` start ticks; macOS uses a fixed-locale, UTC `ps` start timestamp. A matching identity blocks a second watcher; a valid mismatched identity identifies a reused PID. Equal macOS timestamps remain ambiguous within one second and conservatively block recovery. Missing legacy identities, unsupported identity methods, failed probes, foreign ownership, writable directories, symlinks and unexpected files require review; they are never forcibly deleted.

A private `process.lock.guard` is claimed with exclusive creation before inspection and held through stale-owner removal and publication. Release takes the same guard and verifies the owner nonce and file/directory identities. Competing startups may receive `AUTO_LOCK_NEEDS_REVIEW` while an operation is in progress and can retry after it finishes. An abandoned or substituted operation guard is left for manual review; its PID is not used to steal it. This deliberately prefers a recoverable refusal to simultaneous writers. Journal files and previous runs remain untouched. Output directories and files use private permissions. The live journal is capped at 128 MiB per run, and the catalog at 1,000 known threads; exhausting a storage limit pauses rather than deleting older evidence. Previous runs are not automatically deleted, so their disk usage should be reviewed. No remote report server or public network listener is created.

## Verification

```sh
node --test tests/shared/codexCloudAutoWatch.test.js tests/scripts/codexCloudAutoWatch.test.js
npm run verify
```

Earlier device experiments used a separately installed test service. Their receipts are historical observer evidence, not deployment acceptance of this upstream change. No installer, test application or manual-capture entry is included in this proposal.

A real initial automatic run found 66 hosted threads and selected a running existing task without any manually supplied UUID. It received a valid cumulative token event from that task without submitting a model request. A second real experiment intentionally closed only the observer socket; the loop created a new connection, rediscovered the catalog and reattached. No token event happened during the second test window, so numerical continuity across reconnection is covered by the offline regression rather than claimed as a second real positive sample.

The actual counts, opaque thread IDs and per-run receipts are retained in private task-notes outside the repository. Automated tests cover null-source union, new tasks, subagent relationships, active/idle selection, no duplicate resumes, counters before resume response, reconnect, account isolation, capacity, permission failures, process lock, storage bounds, lifecycle shutdown. No synthetic test counter is presented as user usage.

## Limits that remain

Tasks completing entirely between scans, periods when the Mac is asleep/offline, upstream-hidden threads, refused viewer attachments, capped catalog pages and listener capacity can still leave gaps. Very short tasks may finish before discovery/attachment. Existing idle history is not retroactively recovered, and a real billing route returning forbidden is not retried through another identity. This is automatic discovery and real-time listening, not a guarantee of complete historical cloud/dot billing.

The protocol background is the [official App Server documentation](https://learn.chatgpt.com/docs/app-server). Hosted behavior is verified separately in this fork; a local App Server or a matching protocol name is not assumed to expose the same remote catalog.
