---
summary: "MiniMax Code usage: upstream's headless captures plus the fork's read of the shared CLI/desktop runtime store."
ids: [mcode]
read_when:
  - Changing MiniMax Code source detection or watch behavior
  - Debugging missing, doubled or stale MiniMax Code usage
  - Touching the fork's token_monitor/mcode.rs or providers/mcode/paths.js
---

# MiniMax Code

`mcode` is the product's own CLI name and upstream tokscale's client id, so it is the tracked id too. It is unrelated to the `minimax` AI Tool Limits provider, which reads the Token Plan balance; `normalizeClientName()` maps only the product spellings to `mcode` and leaves the bare vendor name alone.

## Sources

| Source | Reader |
| --- | --- |
| `tokscale headless mcode exec` captures under the tokscale headless roots | upstream `sessions/mcode.rs` |
| The runtime store the CLI and desktop app share: `<data-dir>/v2/sessions/<yyyy>/<mm>/<dd>/<dir>/` | the fork's supplement, `crates/tokscale-core/src/token_monitor/mcode.rs` in Javis603/tokscale |

The supplement reports under upstream's `mcode` id rather than as a fork-only client, so nothing migrates if upstream starts reading the store; it is then removed from the fork. Upstream's headless lane runs unchanged, and a turn it already counted in the same scan is skipped by the supplement, because a capture and the store carry the same Session and turn ids.

The data directory is a non-empty `MINIMAX_DATA_DIR`, else `MAVIS_DATA_DIR`, as MiniMax Code resolves it; otherwise `~/.minimax`, the earlier `~/.mavis`, and every `-<profile>` variant of either. `.mavis` is often a link to `.minimax`, so both the fork and `providers/mcode/paths.js` read a store once by its real path. A scan with `--home` (WSL) ignores the overrides, which describe the host.

## Accounting

Each session directory holds `messages.jsonl`, the active history, and `snapshots/g<generation>--<id>.jsonl`, the whole active history before each compaction. Compaction keeps the identity of every message it retains, so assistant messages are counted once by `message_id` across the chain. Pi usage keeps cache reads out of `input`. MiniMax Code reports reasoning inside `output`, while tokscale adds `reasoning` on top of it, so a reported `reasoning` is added only when it cannot be part of `output`.

The runtime also projects usage into the SQLite `local_runtime_token_usage` table, but that projection is best effort (a failed write is swallowed) and records no model, so usage never comes from it. The same database supplies only Session titles and workspaces.

Deleting or rewinding a Session in MiniMax Code removes its history, as in other tools; the deleted-session archive keeps usage already observed.

## Watching and custom paths

The watcher follows each store's `v2/sessions` tree and the headless `mcode` directories. MiniMax Code writes there only during a turn, and the scan does not write back, so the watch cannot re-trigger itself. Custom scan paths are disabled for `mcode`: an extra root would reach only upstream's headless scan, never the store.

The fork caches the usage rows of each history file by length and mtime in `token-monitor/mcode-<home hash>.json` under tokscale's cache directory, one file per scanned home, because history files carry whole conversations and tool output.
