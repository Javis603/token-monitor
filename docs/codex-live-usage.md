# Codex live usage reader

This fork adds an opt-in service reader alongside the existing local-log ledger. The implementation is installed in this source checkout, not in the installed Electron widget. It has been exercised against both a synthetic JSON-RPC peer and the installed Codex app-server. A real account total was returned; real thread token breakdowns were unavailable in the sampled parent/child pair. Cloud/dot attribution acceptance remains outstanding.

## Commands and output

```sh
npm run codex:usage -- --live --help
npm run codex:usage:live -- --help
```

The live entry point takes `--thread ID` repeatedly, `--discover`, `--no-descendants`, `--bindings FILE`, `--codex-binary PATH`, `--codex-home DIR`, `--json`, `--output-dir DIR`, `--watch`, `--interval SECONDS`, and `--timeout SECONDS`. `--help` does not start a subprocess or inspect credentials. Without a thread or discovery option, the reader requests only account activity. `--discover` refers to the connected app-server's catalog, not a universal cloud inventory.

For ordinary authorized use, the one-shot entry is `npm run codex:usage -- --live`. An output directory must not already exist and its parent must exist. Reports are `report.json` and `report.html`. For clean machine-readable stdout without npm's banner use `node scripts/codex-live-usage.js --json`. Output files use private permissions and same-directory temporary-file replacement; JSON and HTML are individually atomic files, not a two-file transaction. Each includes observation times.

`--watch` requires `--output-dir` and runs in the foreground until stopped. Polling defaults to 60 seconds, is serial, and backs off on failures. It installs no daemon or launch agent and does not start a model task. A new invocation refuses to reuse an existing output directory rather than overwrite an unrelated report. The HTML is a standalone local view, not the Token Monitor dashboard; it contains no JavaScript, external fonts, network resources or telemetry.

## Read-only transport and provenance

`usageRpc.js` starts an existing Codex executable as `app-server --listen stdio://`, performs the initialize handshake with experimental API capability, and permits only `account/usage/read`, `thread/read`, and `thread/list`. No `turn/start`, thread resume, account login, configuration write or permission approval method is called. A server-side permission request receives a rejection. The adapter discards stderr and exposes only sanitized error codes; it does not copy credentials or authentication material.

The preferred macOS executable is the existing bundled client, falling back to `codex` on PATH. An explicit binary is a trusted executable supplied by the operator, not an arbitrary remote download. `--codex-home` only passes `CODEX_HOME` to that executable. The executable retains responsibility for its own existing authentication; the reader does not provision a new login or change global routing.

The documented public surface is the [OpenAI App Server guide](https://learn.chatgpt.com/docs/app-server). The per-thread account usage contract is an estimated usage report; see the pinned [GetAccountTokenUsageResponse](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/app-server-protocol/schema/typescript/v2/GetAccountTokenUsageResponse.ts) and [ThreadUsageBreakdownGroup](https://github.com/openai/codex/blob/afb436df8b70bb5bc57b86d9a3e829968988cd21/codex-rs/app-server-protocol/schema/typescript/v2/ThreadUsageBreakdownGroup.ts). A protocol field existing is not proof that a particular cloud task can be queried.

The account normalizer in `src/shared/cloudUsageImport.js` is reused unchanged from this fork's `feat/cloud-usage-import` commit `c3c653492252c65fda4d7906682c9f28f632c397`, SHA-256 `85cb7b7873bcc5ffca1ffdf659f80aebf71a431c535def6a11f74d586019ee17`. The live reader deliberately does not feed estimated responses into that module's reported-task importer.

## Discovery and missing relationships

Explicit roots use `thread/list` with `ancestorThreadId`, all source kinds, both archive states, and `useStateDbOnly: true`. Pagination and total discovery requests are bounded. An older server that rejects experimental ancestry filtering produces a partial inventory diagnosis; the code does not silently fall back to an unbounded full scan. `--discover` scans the connected catalog instead. Thread metadata reads set `includeTurns: false`.

Observed parent IDs and explicitly declared relationships form a cycle-safe graph. Referenced parents remain visible even without usage. Unknown or unreadable children are not converted to zero. Conflicting parents are cleared and diagnosed. Direct usage lookup is still attempted for a supplied ID when its metadata is unavailable. The connected server may not host a cloud thread, may have an incomplete catalog, or may not expose the expected ancestry fields. These cases must not be labeled full-account coverage.

Task/dot IDs are not inferred from names, paths, local source kinds or usage totals. Optional bindings use this fork's own versioned declaration, not an official export schema:

```json
{"version":1,"kind":"codex-usage-bindings","threads":[{"threadId":"real-engine-thread-id","taskId":"verified-task-id","dotId":"verified-dot-id","execution":"cloud","creationSource":"dot"},{"threadId":"expected-child-id","parentThreadId":"real-engine-thread-id"}]}
```

Only supply a mapping supported by an actual task record. The code labels bindings `user-declared`, not service-verified. `execution` and `creationSource` otherwise remain `unknown`; `accountCloudCoverage` remains `unknown` even when some thread counters are available. A missing real task-to-engine-thread join cannot be repaired by inventing a binding.

## Counting and lifecycle invariants

The account summary and daily buckets overlap. They are not added together or allocated to cloud versus local work. Thread usage is tagged `estimated` and `lifetime`; its model groups are validated but credits/USD are never converted to tokens. Cached input is a subset of input, and total is checked against input plus output when all three are supplied. Missing counters remain null, explicit zero remains zero, impossible counters and unsafe integer sums fail validation.

`taskTotalTokens` is null: the interface has not established whether a parent estimate already includes descendants. Do not add parents to children, combine this view with local Tokscale periods, or classify the service response as a per-request measured ledger. A fresh poll replaces the previous snapshot, allowing downward corrections without accumulating duplicates.

Each poll opens a new connection. Account changes within a poll invalidate its entire result. Notifications advance an account revision; the CLI discards all sampled values and recollects at most once on that same connection. A further notification fails closed rather than joining different revisions or retrying indefinitely. This handles delayed startup notifications without ignoring actual account changes. When a new connection fails, the last report body is cleared rather than exposed under an unverified account identity; a previous success time may be retained only as a diagnostic. Failure is `unavailable`, never a fresh zero report. Explicit termination produces `stopped`. An abruptly killed viewer cannot update the last file, so timestamps remain essential even when a historical file says `fresh`.

Exports contain allowlisted usage, thread/task/dot identifiers, provenance and sanitized diagnostics. They omit conversation titles, message bodies, previews, tool arguments, working directories and raw errors. Opaque identifiers and model labels can still be sensitive; review reports before sharing.

## Verification and acceptance boundary

```sh
node --test tests/shared/codexLiveUsage.test.js tests/scripts/codexLiveUsage.test.js \
  tests/shared/codexTaskUsage.test.js tests/scripts/codexTaskUsage.test.js
npm run update:hub-build
npm run verify
```

The fixture `tests/fixtures/codexUsageRpc.cjs` is a synthetic local process, not Codex and not an authenticated account. It verifies the CLI → stdio RPC → normalization → thread relationships → private JSON/HTML path, including failures. Fixture counters must never be presented as user usage. Current tests also reproduce and prevent unrelated catalog budget exhaustion, loss of an explicitly referenced parent, and exposure of an earlier account body after a failed reconnection.

Real acceptance requires an authorized cloud/dot task record, its actual engine-thread identity, a supported usage response and a comparison that determines parent/descendant coverage. The attempted live probe in this session was blocked by platform safety checking. No equivalent request was retried through another tool, executable or agent. Offline integration continues independently; the source checkout being ready is not a claim that real cloud/dot statistics or the installed Electron dashboard have been verified.

## Separate macOS test application

`python3 scripts/deploy-codex-usage-test.py --apply --thread ENGINE_THREAD_ID` installs `~/Applications/Token Monitor Usage Test.app`, not the production Token Monitor. The installer rejects an existing destination and any production app name. It copies only the static local module dependency closure (Node built-ins only), records SHA-256 hashes and source commit/dirty state, and reuses the already installed Node executable. It never copies authentication files or the repository's `node_modules`.

Double-clicking the test app requests one fresh service report, then opens its local HTML. Reports, a sanitized lifecycle receipt and `settings.json` live separately under `~/Library/Application Support/Token Monitor Usage Test/`. The optional `threadIds` list selects real engine roots. The companion `本地线程统计.command` uses the same packaged code to report one root and its descendants from local logs. A local-only invocation requires exactly one configured root. No startup service or automatic updater is registered.

The source test launcher can be run with `--headless` for file-based acceptance without opening a browser, or `--local --thread ID --headless` for local-log acceptance. Removing the separate app rolls back deployment without affecting the production widget. Reports remain for explicit user cleanup.
