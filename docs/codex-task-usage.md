# Codex task and delegated-thread usage

This fork adds an **on-demand CLI**, separate from the existing Tokscale dashboard totals. It measures observed lifetime token usage by thread and can group known descendants. It is not an account billing statement, daily total, or a hosted-cloud synchronization service.

## Run

From the repository root, with the supported Node runtime:

```sh
npm run codex:usage
npm run codex:usage -- --thread THREAD_ID
npm run codex:usage -- --thread THREAD_ID --json --output report.json
npm run codex:usage -- --codex-home /path/to/.codex --thread THREAD_ID
```

`--output` creates a new file with mode 0600 and refuses to overwrite anything. Without it, output goes only to stdout. Use `--help` for all options. For clean machine-readable stdout, call `node scripts/codex-task-usage.js --json` directly instead of npm's banner-producing wrapper.

The default scan uses `CODEX_HOME` or `~/.codex`, the existing versioned database discovery, and read-only SQLite queries. All cataloged sources, archived threads, and `thread_spawn_edges` are included. Source JSON supplies parent relationships on older schemas. Only `.jsonl` rollouts under `sessions` or `archived_sessions` are accepted; final-component symlinks and path escapes are rejected. Selecting a thread scans only its cataloged descendants, not every transcript. Logs not indexed in an accessible catalog are not auto-discovered.

## Cloud and dots: explicit evidence, not inferred zero

**Automatic hosted-cloud/dots account fetching and dashboard integration are not implemented.** A local Codex database does not prove cloud-account completeness. A cloud CLI task list can differ from Work/dots tasks; an empty list is not proof that cloud usage is zero. This feature never reads authentication files, cookies, browser storage, or account credentials; it never launches or replays model turns to obtain statistics.

Import actual usage events from an execution environment or an authorized client that exposes them:

```sh
npm run codex:usage -- --no-local --events cloud-events.jsonl --thread cloud-root --json
npm run codex:usage -- --events cloud-events.jsonl --events another-export.jsonl
```

`--no-local` avoids local database reads. Repeatable `--events` accepts newline-delimited objects in these supported forms:

```json
{"method":"thread/started","params":{"thread":{"id":"cloud-root"}}}
{"method":"thread/tokenUsage/updated","params":{"threadId":"cloud-root","tokenUsage":{"total":{"inputTokens":90,"cachedInputTokens":50,"outputTokens":10,"reasoningOutputTokens":3,"totalTokens":100}}}}
{"type":"token_usage_record","payload":{"thread_id":"cloud-root","response_id":"response-1","usage":{"input_tokens":90,"cached_input_tokens":50,"output_tokens":10,"reasoning_output_tokens":3,"total_tokens":100}}}
```

It also accepts native rollout `session_meta` plus `event_msg` / `token_count` / `info.total_token_usage`. A snapshot event without a thread identity cannot be attributed. The App Server notification shape is documented in the [official App Server reference](https://developers.openai.com/codex/app-server/); this is not a promise that a local server exposes remote account history.

For a task whose expected children or dot association are known externally, precede events with **this fork's own versioned manifest** (not an official cloud export schema):

```json
{"type":"token-monitor.task-manifest","version":1,"threads":[{"id":"cloud-root","taskId":"task-1","dotId":"dot-1","executionEnvironment":"cloud"},{"id":"child-1","parentThreadId":"cloud-root","executionEnvironment":"cloud"},{"id":"child-without-usage","parentThreadId":"cloud-root"}]}
```

A dot/task identifier must come from real task linkage, not a guessed display name. The manifest only declares metadata; it does not manufacture usage or attest to complete child discovery. `accountCloudCoverage` remains `unknown`, including when some cloud tasks have measured records.

## Accounting and coverage

`knownUsage` is the sum of the selected threads' available `ownUsage`. With `--thread`, `rootOwnUsage` and `descendantsKnownUsage` split the main thread from all known descendant levels. Parent rows are not pre-aggregated, so children are counted only once. No measured rows produce `null`, not zero. Every known child without valid usage stays in the report.

Per-request `token_usage_record.payload.usage` is preferred and keyed by `response_id`. The `thread_id` in the record owns the usage, even when its record was inherited into another rollout. `turn_token_usage`, `thread_token_usage`, last-request snapshots, and cumulative snapshots are never added to those records. Conflicting copies are excluded and diagnosed.

A matching complete-field request sum and final snapshot is `reconciled` for the observed log. A mismatch retains the deduplicated request sum as a partial observed total and exposes the larger/different snapshot separately as `reportedLifetimeUsage`; it does not silently fill missing history. Newer event streams can omit old requests, so this distinction matters.

Without request records, the highest monotonic cumulative snapshot is shown as `snapshot-only`, not as a verified per-request billable total. Snapshot history that resets, a declared fork, or a mismatched rollout identity cannot supply fallback own usage. Exact repeated observations are ignored. Timestamps distinguish otherwise identical resets; when timestamps and request IDs are absent, identical counter reuse cannot be distinguished from replay. Snapshot-only totals therefore have limited evidence even when numerically plausible. Unknown, undiscovered, or inaccessible cloud threads are never asserted to be covered.

Cached input is a subset of input and reasoning is a subset of output: `total = input + output`. Optional breakdown fields remain `null` when not supplied. Negative, fractional, unsafe, conflicting or impossible counters are rejected. Aggregate integer overflow fails the command rather than rounding. Model/provider fields describe available thread metadata, not a proven per-request pricing identity; no API-price estimate, credits conversion, or quota conversion is made.

**Do not add this report to Token Monitor's existing period totals.** Those may already include these local requests. Integrating a UI and cloud data source requires one shared deduplication boundary and verified task linkage first.

## Privacy and resource bounds

Only allowlisted thread IDs, relationships, model/provider names, declared task/dot IDs, counters, evidence labels and diagnostic codes leave the parser. No conversation text, title, working directory, tool argument, creator identity or credential is included in exports. Reports still contain usage and task identifiers: review them before sharing publicly.

Files are streamed in 64 KiB chunks with a 1 MiB line cap, 512 MiB file cap and 4 GiB total scan budget. Oversized/malformed/truncated records, missing databases, unsupported schemas, unreadable files, changed-during-read files, parent cycles, and numeric conflicts produce diagnostics. Limits are not silently presented as complete scans. A running log can change after the read; results are observations, not a frozen account ledger. No watcher, background uploader, cloud task, or network service is installed.

## Verification

```sh
node --test tests/shared/codexTaskUsage.test.js tests/scripts/codexTaskUsage.test.js
npm run verify
```

Tests cover real-format SQLite/rollout integration, cumulative replay, request deduplication, recursive descendants, missing child coverage, invalid counters, fork/reset ambiguity, cycles, imports, path escapes, privacy and CLI output protection. Live acceptance must separately compare an actual stable log's unique request sum with the CLI result and snapshot. Automated fixtures are not hosted-cloud endpoint validation.

## Separate live service view

`npm run codex:usage -- --live` selects the separate [live service reader](codex-live-usage.md). It does not merge service estimates into this local-log ledger. Its source checkout is integrated; real hosted-cloud/dot attribution and parent coverage still require acceptance.
