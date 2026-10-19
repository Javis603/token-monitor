---
summary: "Explicit DeepTutor ledger paths, disjoint reported/estimated usage, and native-parser release dependency."
ids: [deeptutor, deeptutor-estimated]
read_when:
  - Changing DeepTutor discovery, watching or token accounting
---

# DeepTutor

## Identity and ids

`deeptutor` contains provider-reported counts; `deeptutor-estimated` contains DeepTutor estimates. Both are opt-in, fork-only clients, with explicit labels. Selecting both counts each call once. They are distinct from Codex, even when DeepTutor uses its own Codex OAuth connection. These are usage sources, not limits providers.

## Data sources

Set an absolute `TOKEN_MONITOR_DEEPTUTOR_DB_PATH` in the collector process environment, or an absolute `DEEPTUTOR_HOME`; the latter resolves to `data/user/usage.sqlite3`. An explicit invalid path never falls back to another account. DeepTutor defaults to its launch directory, so guessing `~/.deeptutor` or using Token Monitor's cwd is incorrect. Non-admin accounts require an explicit path to their own ledger; there is no account/project enumeration.

The fork parser reads only the official v1.6.14 `llm_calls` ledger, read-only. Its fields are `call_id`, `started_at` (Unix seconds), `session_id`, `turn_id`, `source`, and `usage_json`. It does not read credentials, prompts, notebooks or course material. SQLite WAL commits refresh the cache; failed or over-budget reads retain the last complete snapshot rather than publishing a partial negative delta. Unknown precision and malformed rows are not treated as exact usage.

## Source precedence

Only the ledger is collected. DeepTutor's conversation snapshots may repeat those calls and are not added again. Historical calls recovered only from conversations are deliberately outside this initial integration; no ledger does not prove no past usage. A DB path change invalidates the collector anchor. WSL scans exclude these env-selected sources to avoid reading host data twice.

## Invariants and known gaps

DeepTutor's prompt counter includes cache-read/cache-creation counts, and completion includes reasoning. The parser splits these into disjoint buckets; Token Monitor restores inclusive display output without adding reasoning twice. Estimated and OAuth calls remain unpriced; zero calculated cost is not a statement that usage is free or an invoice. Estimated calls have no measured throughput.

The watcher observes only the selected database and its WAL, not the surrounding settings/course files or SHM events. No new timers, network requests, credentials or dependencies are required.

**Release dependency:** this wiring needs the [DeepTutor parser](https://github.com/Javis603/tokscale/pull/19) and a maintainer-published fork build. Update the vendor pin and verify every supported platform before shipping. The current pin is intentionally not replaced with a fabricated version/hash. A catalog entry alone is not a working integration.

## Verification

`node --test tests/shared/deeptutorSources.test.js tests/shared/clientPartitionInvariants.test.js tests/shared/tokscaleTokenContracts.test.js`

Set `TOKEN_MONITOR_TEST_TOKSCALE` to an absolute locally built fork binary and run `node --test tests/shared/deeptutorBinary.test.js` for an offline binary-to-collector check. It scans only the synthetic DeepTutor ledger. The test is explicitly skipped without that binary; a skipped test is not runtime acceptance.

`npm run verify` covers shared registration and docs. `node scripts/verify-vendored-tokscale.js --help` is not an integration test: run the actual gate against a built parser and verify both clients' synthetic SQLite fixtures. Packaged desktop UI and macOS/Linux runtime acceptance remain separate.
