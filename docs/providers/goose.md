---
summary: "Local Goose cumulative usage, pinned scanner precedence and upstream date/path limitations."
ids: [goose]
read_when:
  - Changing Goose tracking, source health or watch roots
  - Updating the Goose token contract or Tokscale pin
---

# Goose

## Identity and ids

`goose` is a default-tracked, upstream-parsed client, not a fork-only client or limits provider. Desktop and CLI share one local database when they use the same absolute `GOOSE_PATH_ROOT`. ACP downstream Claude Code/Codex sessions may also be counted by those clients; users can disable a tracked client to avoid that overlap.

## Data sources

The pinned Tokscale parser reads session counters and model configuration from `sessions.db`, without reading conversation content. It prefers each `accumulated_*` counter when non-null, falling back independently to the matching non-accumulated counter. An accumulated zero is authoritative. Sessions without a valid model name are omitted.

Token Monitor counts input + output. Cache is already included in input; the parser's `reasoning` is an inferred gap between the reported total and input + output, not a measured additive bucket. Do not add it to output or totals. Cost is a Tokscale estimate, not Goose's `accumulated_cost`.

The parser treats each cumulative session as one record, so the generic UI's `1 call` is not a real call count, and estimated cost may price the inferred reasoning gap at the output rate without separating cached input for discounts even though Token Monitor's token total does not add that gap again.

## Source precedence

The scanner contract follows upstream `3542e1c129d2c5f4c69970c10b9398c0a54e73b2`; `scripts/vendor/tokscale.json` remains the authority for the installed build while the alignment is prepared.

A raw absolute `GOOSE_PATH_ROOT` is authoritative: only `<root>/data/sessions/sessions.db` is scanned, even if it is absent. Do not trim the value or fall through to default databases. Relative and whitespace-prefixed values are ignored.

Without a valid override, the scanner opens the first existing database:

1. On Windows, `%APPDATA%/Block/goose/data/sessions/sessions.db` when APPDATA is non-empty. Otherwise try the native roaming known folder (or native profile `AppData/Roaming` fallback), then Desktop's `HOME/AppData/Roaming` candidate. APPDATA is not trimmed; a configured APPDATA suppresses those other Windows candidates even if its database is absent.
2. `XDG_DATA_HOME/goose/sessions/sessions.db`, falling back to `~/.local/share/goose/sessions/sessions.db` when the variable is unset or blank. Token Monitor's `tokscaleCommand()` removes blank XDG values before spawning; source health and watch roots use the same fallback.
3. `~/Library/Application Support/goose/sessions/sessions.db`.
4. `~/Library/Application Support/Block/goose/sessions/sessions.db` (no `data/`).
5. `~/.local/share/Block/goose/sessions/sessions.db`.

An explicit Tokscale `--home` scan ignores host APPDATA, HOME and GOOSE_PATH_ROOT, checking `<home>/AppData/Roaming/Block/goose/data/sessions/sessions.db` before the compatibility candidates on every host OS. Normal host collection uses environment-aware discovery. The App reuses its existing native Windows known-folder lookup for health and watch roots. Existing candidate directories remain watched so a higher-priority database created there is discovered after startup; a missing parent directory waits for the regular root refresh. A valid override makes only its own path eligible.

An empty or unreadable earlier database shadows later files; the scanner does not union them or fall through after parsing. Source diagnostics and watch candidates preserve this order. Health probes the exact database, never just an existing directory or sidecar. The watcher admits only direct `sessions.db`, `sessions.db-wal` and `sessions.db-shm` children; configuration, credentials, nested databases and other files stay excluded. WSL discovery uses the two Linux home-relative database markers and scans only running distros; custom environment roots are not discovered there.

The checksum-matched macOS arm64 binary rewrites the SHM wal-index during read-only WAL scans (mtime changed on three reads, bytes changed on two). The existing SQLite sidecar guard therefore suppresses Goose SHM events as scan triggers; DB and WAL events remain triggers. Keep that distinction to avoid a self-triggered collection loop.

## Invariants and known gaps

- macOS/Linux local cumulative usage retains its compatibility paths. Windows default discovery is included in the aligned scanner; real Windows runtime acceptance remains separate from source and mocked-platform tests.
- The legacy macOS `~/Library/Application Support/Block/goose/data/sessions/sessions.db` is still not scanned. Keep it out of watches and presence signals.
- Goose and the aligned scanner both require a raw absolute `GOOSE_PATH_ROOT`.
- The entire cumulative session is assigned to `created_at`. Continuing a session on a later day stays on the creation day; the pinned parser does not read `usage_ledger`. Today and daily history therefore cannot represent later-day calls accurately.
- `TOKSCALE_EXTRA_DIRS` contributes no Goose usage. Keep Goose out of `customScanPaths`.
- Remote goosed stores, quota collection, title/project/context/duration metadata and conversation reading are outside this integration. The parser reports one message per session; do not present that as a real conversation message count.

## Verification

Run `node --test tests/shared/gooseSources.test.js tests/shared/tokscaleTokenContracts.test.js`, then `node scripts/verify-vendored-tokscale.js` against the checksum-verified pinned binary. The gate exercises cumulative fallback/zero semantics, inferred reasoning, creation-day filters, ordered path shadowing, authoritative overrides, Windows/explicit-home discovery, rejected extra directories and uncheckpointed WAL writes. Real Linux, Windows and WSL execution remain separate platform acceptance checks.

Sources: [approved integration boundary](https://github.com/Javis603/token-monitor/issues/980#issuecomment-6149136487), [pinned parser](https://github.com/Javis603/tokscale/blob/fa5f0c13324838d1a988fda317597f9b90da7ad0/crates/tokscale-core/src/sessions/goose.rs), [aligned scanner](https://github.com/junhoyeo/tokscale/blob/3542e1c129d2c5f4c69970c10b9398c0a54e73b2/crates/tokscale-core/src/scanner.rs). The SVG mark and README raster use the maintainer-supplied Goose artwork.
