---
summary: "MiniMax Code desktop and CLI share one SQLite usage ledger. Token Monitor reads that ledger locally and keeps it out of the tokscale delta."
ids: [minimaxcode]
read_when:
  - Changing MiniMax Code usage collection, history replacement, or read-failure retention
  - Debugging missing or stale MiniMax Code totals
---

# MiniMax Code

Desktop and CLI write the same `local_runtime_token_usage` table. There is no field that says which surface produced a row, so both are the client `minimaxcode`. The existing MiniMax limits card is a separate Token Plan balance and is not this ledger.

## Source

The database is `v2/sqlite/runtime-state.sqlite` under `MINIMAX_DATA_DIR`, otherwise `MAVIS_DATA_DIR`, otherwise the first existing `~/.minimax` or `~/.mavis` directory. An explicit env path is not replaced by the other home when it is missing. `.mavis` on this machine is often a junction to `.minimax`; discovery lists both, and a read collapses them by real path.

Usage rows and session metadata (`effectiveModel`, `workspace_dir`) are read in one read-only transaction. If the session table is missing, token rows are still kept and the model or project is left unknown. A missing database is "not installed". A database that cannot be read, or that exceeds the row cap, is a failed read: same-day, same-database periods can be shown again, but yesterday's today and last month's month are not reused as the new window. The health record then says the read failed.

Tokscale's `mcode` headless capture is not read. Adding it would count the same turns twice.

About 52,815 tokens in two sessions exist in session files and not in this table. Those files are not merged in.

## Periods and history

The three periods are rebuilt from that one snapshot and stored beside the tokscale anchor. They are merged onto a base that does not already contain `minimaxcode`. They do not go through `applyPeriodDelta`, and they are not a slot in `todayPartitions`. A watch of another client republishes the stored MiniMax periods when the day, month, and database still match.

The daily archive normally keeps the larger observation. MiniMax replaces its own observations on every stored day and every live-history day, including dates the new snapshot no longer has. A failed read does not touch that archive.

## Cost

`cost_usd` in the table is not treated as a bill. Amounts are list-price estimates from the existing price lookup. A row with no price adds nothing to the estimate, and the wire total stays a number, so an incomplete estimate can still display as zero. That zero is not Token Plan spend and is not proof the turn was free.

Rows with an empty model use the session's last `effectiveModel`. That labels the tokens, but it is not a per-request model record.

## Watch

The watcher follows `runtime-state.sqlite` and its `-wal` only. `-shm` is ignored. Whether a read-only open rewrites the database or WAL is checked against an idle fixture before any file is dropped from the watch.
