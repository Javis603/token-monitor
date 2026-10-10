---
summary: "CatPaw local assistant usage: one opt-in fork-only client covering both editions, edition-specific model maps, read-only SQLite sources, and the verification boundaries that remain."
ids: [catpaw]
read_when:
  - Changing CatPaw source discovery, watching, health or token accounting
  - Updating CatPaw edition roots or the fork parser's model baseline
  - Investigating CatPaw usage that is missing, zero or stale
---

# CatPaw

## Identity and ids

`catpaw` is one opt-in tracked client, marked `forkOnly` and off by default. It covers the domestic and overseas CatPaw assistant apps — the domestic product was renamed 妙手 while its package name and data directories keep the CatPaw spelling — on macOS and Windows. The edition is derived from the data root; no client field carries it, and model numbers must not be used to infer it.

The internal id stays `catpaw` and the display label is `CatPaw`. There is no limits provider, no credential flow and no network model refresh: Token Monitor discovers roots, watches files and reports health, while the tokscale fork's `token_monitor::catpaw` module performs every read. CatPawAI IDE is out of scope until a current build persists local token records; IDE id spaces do not translate to the assistant's.

## Data sources

| Edition | macOS | Windows |
| --- | --- | --- |
| Domestic | `<effective home>/Library/Application Support/catpaw-moon/` | native roaming app-data `\catpaw-moon\` |
| Overseas | `<effective home>/Library/Application Support/catpaw-overseas/` | native roaming app-data `\catpaw-overseas\` |

Windows resolves the roaming root through `FOLDERID_RoamingAppData`, not the `APPDATA` environment variable, matching the fork's `dirs` lookup; an explicit `--home` or a redirected `HOME` resolves `<home>/AppData/Roaming/<edition>` instead through `PathRoot::AppData`. Linux reads no source: no product root has been verified, and reader fixtures are not evidence of one. `--user-data-dir` overrides are not auto-discovered.

Discovery accepts only immediate `catpaw-memory-<scope>.db` files whose scope is non-empty and limited to ASCII letters, digits, `_` and `-`; the exact scope `anon` is excluded. Non-anonymous historical account databases are included: this is the machine's retained history, not the current login's usage, and no login state is read to filter it.

Each assistant message stores usage at `payload.extra.contextInfo.usage`: `promptTokens`, `completionTokens`, `cacheReadTokens`, `cacheWriteTokens` and `totalTokens`. The four buckets are disjoint and additive. A row is accepted when their sum equals the row's `usage.totalTokens` or the sibling `contextInfo.totalUsageTokens` — older builds stored the first without the cache-read part, so the anchor is chosen per row, and only nonnegative integral JS-safe numbers anchor. Rows with missing or explicit JSON-null usage are skipped; malformed non-null usage fails the whole source read. Reasoning and one-hour cache-write tokens are not independently persisted and stay zero; nothing is inferred from a residual or a duration. Timestamps use `created_at_ms` with `updated_at_ms` as fallback, and the outer date filter applies as usual.

Messages are rewritten per conversation, not appended: a read takes a complete snapshot, deduplicates by message identity, and a successful read reflects deletions. A row whose created and updated timestamps are both absent or out of range is stored at the epoch and falls outside any `--since` window. Project or workspace attribution, session titles and context occupancy are not provided.

## Source precedence

Both editions are scanned together; there is no current-account filter and no region precedence. `--user-data-dir` aside, the default roots above are the only supported locations.

The watcher keeps each edition root for new-account discovery and accepts only the database/WAL/SHM family; authentication stores, application logs and nested directories are pruned. Because a read-only WAL scan rewrites the wal-index, `catpaw` is in `SELF_WATCHED_SQLITE_SIDECAR_CLIENTS`: `-shm` events are suppressed while database and `-wal` events still trigger collection.

The account-database set is part of the collector's config fingerprint. Adding or removing a database clears the persisted anchor and forces a full re-baseline, because historical usage cannot be recovered from a today-only delta; a set change observed between the serial period scans discards the mixed result and reuses the same bounded single replay as a pricing change.

## Credentials and transport

None. No credential is read, stored or sent, no application code is executed, and no network request is made for usage or model data. The parser opens SQLite read-only with a bounded busy timeout and never migrates, cleans or writes application tables.

## Invariants and known gaps

- Model ids are edition-specific namespaces: `0` maps to auto on both editions and `10000003` is additionally auto overseas. Auto is a routing tier and is never priced. The current mapping snapshot lives in the fork module; a name/id pair observed for one edition does not transfer to the other.
- The session's current selection (`persistedModelId` / `persistedModelMode` / `persistedModelSelection`) takes precedence over the legacy initial fields. A selection is valid only with a Boolean `isAuto`, a safe-integer `modelId` and, when present, a valid safe-integer `lastSelectedModelId`; otherwise the legacy mode routing applies. `lite` / `pro` / `max` remain routing tiers, conflicting current ids and unmapped ids stay unknown, and no lower-priced model is substituted.
- Auto keeps the label `auto`; routing tiers, unknown and conflicting ids keep an edition-qualified label. All use the `unpriced:catpaw` provider, which blocks automatic catalog pricing. Explicit user custom pricing still applies under the fork's pricing rules. `rateMultiplier` is a credit multiplier, never a token price.
- Model selection is session state, not per-message identity: changing a session's model relabels its earlier usage. That ceiling is inherent to the stored data.
- Each source is fingerprinted by database and WAL size/mtime; unchanged sources are not re-read. A changed source is replaced whole or not at all — schema, JSON, identity, counter, budget or I/O failures retain the last complete snapshot and log a warning; a confirmed removal clears its rows; a successful empty read is empty. Budgets: 256 databases per edition, 100,000 usage rows and 50 MiB projected per database.
- A stable `catpaw.lock` sidecar serializes cache load, scanning and publication across concurrent CLI processes, so an older scan cannot overwrite a newer complete snapshot. Without the lock, sources are still read but no cache is written, and a competing scan waits for the holder.
- Changes to older days inside an existing database (deletion or model relabeling) reach history only at the next full reconciliation; today-only watch deltas cannot repair them.
- Observed real samples (four domestic, three overseas usage rows) satisfied the four-bucket identity with `cacheWrite` always zero. Nonzero cache write, tool/sub-agent rows and legacy runtime formats are covered only synthetically; do not present them as verified.
- The domestic Windows storage contract was verified statically through installer and `app.asar` inspection; the [issue reporter's real-machine evidence](https://github.com/Javis603/token-monitor/issues/715#issuecomment-6020857899) also confirms its paths, schema and 169 usage rows. The overseas Windows root is inferred from the product contract. Windows file-lock, WAL and SHM behaviour still lacks a real-machine check, as does the overseas Windows installer.
- Linux and WSL read no CatPaw source. Under a Windows host the root is app-data-relative, so a WSL scan would recount host usage; `catpaw` is in `WSL_EXCLUDED_CLIENTS`.
- Runtime capability fallback probes fork clients individually after a rejected batch, so a pre-CatPaw fork keeps its supported Proma/Qoder CN clients. The clients gate still requires every registered client, so the vendor pin must carry the fork parser.

## Icons

`assets/icons/catpaw.svg` preserves the official brand vector extracted from the app bundle, and `catpaw-mask.svg` preserves its white paw-fill paths — the original black outline becomes transparent separation through a luminance mask, so the paws stay recognizable in a single-color mark. Both keep the original 64×64 viewBox, and the presentation entry uses the mask for both row marks and the tray. No website image is needed.

## Verification

```bash
npm run verify
node scripts/verify-vendored-tokscale.js
node scripts/verify-vendored-tokscale-clients.js
```

The token-contract fixture covers a synthetic nonzero-cache-write row and applies only to darwin and win32. The release script checks every downloaded platform asset and is expected to run in CI. None of this stands in for real-machine behaviour: the parser's own tests live in the fork under `token_monitor::catpaw` (`cargo test -p tokscale-core token_monitor::catpaw`).
