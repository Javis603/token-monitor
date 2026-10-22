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

The fork parser reads only the [official v1.6.14 `llm_calls` ledger](https://github.com/HKUDS/DeepTutor/blob/6cf793bd868ba5ecbe64722936d4be8fab5a01df/deeptutor/services/llm/usage_ledger.py), read-only. Its fields are `call_id`, `started_at` (Unix seconds), `session_id`, `turn_id`, `source`, and `usage_json`. It does not read credentials, prompts, notebooks or course material. Both partitions come from one SQLite snapshot per scan; selecting only one filters that snapshot. A call replaced with reported counters therefore moves out of the estimated partition rather than being counted twice.

SQLite WAL commits refresh the cache. A missing/inaccessible ledger, invalid schema or over-budget read retains the last complete snapshot and emits a warning; it does not claim the retained values are fresh. A successfully read empty ledger clears old usage. Unknown precision and malformed counters are omitted with a count-only warning, not treated as reported tokens. Without a prior complete cache, a failed read returns no usage; that is not proof that no usage exists.

## Source precedence

Only the ledger is collected. DeepTutor's conversation snapshots may repeat those calls and are not added again. Historical calls recovered only from conversations are deliberately outside this initial integration; no ledger does not prove no past usage. A DB path change invalidates the collector anchor. WSL scans exclude these env-selected sources to avoid reading host data twice.

## Invariants and known gaps

DeepTutor's prompt counter includes cache-read/cache-creation counts, and completion includes reasoning. The parser splits these into disjoint buckets; Token Monitor restores inclusive display output without adding reasoning twice. Estimated and OAuth calls remain unpriced; zero calculated cost is not a statement that usage is free or an invoice. Estimated calls have no measured throughput.

The watcher observes only the selected database and its WAL, not the surrounding settings/course files or SHM events. No new timers, network requests, credentials or dependencies are required.

Source reads are limited to 100,000 rows, 64 MiB of selected text and 64 KiB per usage JSON. Limits reject the scan, not just its tail. Cached JSON is read with a bounded stream; corrupt cache data is rebuilt from the ledger. Concurrent collectors may read, but only the holder of the nonblocking cache lock can publish an atomic cache replacement. Removing the source environment setting disables collection; temporary source disappearance alone preserves the last good cache.

**Release dependency:** this wiring needs the [DeepTutor parser](https://github.com/Javis603/tokscale/pull/19) and a maintainer-published fork build. Update the vendor pin and verify every supported platform before shipping. The current pin is intentionally not replaced with a fabricated version/hash. A catalog entry alone is not a working integration.

## Verification

`node --test tests/shared/deeptutorSources.test.js tests/shared/clientPartitionInvariants.test.js tests/shared/tokscaleTokenContracts.test.js`

For an offline binary-to-collector check, use the fork branch containing the parser. From that checkout:

```sh
cargo test -p tokscale-core --lib token_monitor:: --locked
cargo build -p tokscale-cli --locked
```

Then, from the Token Monitor checkout (PowerShell):

```powershell
$env:TOKEN_MONITOR_TEST_TOKSCALE = 'C:\path\to\tokscale\target\debug\tokscale.exe'
node --test tests/shared/deeptutorBinary.test.js
Remove-Item Env:TOKEN_MONITOR_TEST_TOKSCALE
```

On macOS/Linux:

```sh
TOKEN_MONITOR_TEST_TOKSCALE=/path/to/tokscale/target/debug/tokscale node --test tests/shared/deeptutorBinary.test.js
```

The tests create only synthetic DeepTutor data, override source/cache paths in subprocesses and disable network pricing. They cover each partition's token contract, repeated reads, source DB/WAL hashes, a committed estimated-to-reported replacement, source unavailability, a valid empty ledger and unknown precision. They do not invoke a model or read an installed DeepTutor account. Without the binary environment variable they are explicitly skipped; a skip is not runtime acceptance. The existing vendored-binary CI sets that variable to its selected release executable and runs these tests on all four packaged targets after the capability check passes.

`npm run verify` covers shared registration and docs. Before release, publish the companion parser build, update `scripts/vendor/tokscale.json` using that release's real asset metadata, and pass both `node scripts/verify-vendored-tokscale-clients.js` and `node scripts/verify-vendored-tokscale.js` on the packaged targets. Do not disable these gates to bypass the old binary's missing client ids. Packaged desktop UI acceptance remains separate from CLI tests.
