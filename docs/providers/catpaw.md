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

The Windows default is the native roaming app-data folder, not the `APPDATA` environment variable. An explicit `--home` or a redirected `HOME` resolves `<home>/AppData/Roaming/<edition>`. Linux reads no source: no product root has been verified, and reader fixtures are not evidence of one. `--user-data-dir` overrides are not auto-discovered.

Discovery accepts only immediate `catpaw-memory-<scope>.db` files whose scope is non-empty and limited to ASCII letters, digits, `_` and `-`; the exact scope `anon` is excluded. Non-anonymous historical account databases are included: this is the machine's retained history, not the current login's usage, and no login state is read to filter it.

Each assistant message stores usage at `payload.extra.contextInfo.usage`: `promptTokens`, `completionTokens`, `cacheReadTokens`, `cacheWriteTokens` and `totalTokens`. The four buckets are disjoint and additive. A row is accepted when their sum equals the row's `usage.totalTokens` or the sibling `contextInfo.totalUsageTokens` — older builds stored the first without the cache-read part, so the anchor is chosen per row, and only nonnegative integral JS-safe numbers anchor. Rows with missing or explicit JSON-null usage are skipped; malformed non-null usage fails the whole source read. Reasoning and one-hour cache-write tokens are not independently persisted and stay zero; nothing is inferred from a residual or a duration. Timestamps use `created_at_ms` with `updated_at_ms` as fallback, and the outer date filter applies as usual.

Messages are rewritten per conversation, not appended: a read takes a complete snapshot, deduplicates by message identity, and a successful read reflects deletions. A row whose created and updated timestamps are both absent or out of range is stored at the epoch and falls outside any `--since` window. Project or workspace attribution, session titles and context occupancy are not provided.

## Source precedence

Both editions are scanned together; there is no current-account filter and no region precedence. `--user-data-dir` aside, the default roots above are the only supported locations. Adding or removing an account database triggers a full re-baseline, because historical usage cannot come from a today-only delta.

Tool details show both edition roots even when they are missing, including before tracking is enabled.

The watcher follows each edition root for new accounts and the database/WAL family. Authentication stores, application logs, nested directories and shared-memory sidecars are ignored.

## Credentials and transport

None. No credential is read, stored or sent, no application code is executed, and no network request is made for usage or model data. The parser opens SQLite read-only with a bounded busy timeout and never migrates, cleans or writes application tables.

## Invariants and known gaps

- Model ids are edition-specific namespaces: `0` maps to auto on both editions and `10000003` is additionally auto overseas. Auto is a routing tier and is never priced. The current mapping snapshot lives in the fork module; a name/id pair observed for one edition does not transfer to the other.
- The session's current selection (`persistedModelId` / `persistedModelMode` / `persistedModelSelection`) takes precedence over the legacy initial fields. A selection is valid only with a Boolean `isAuto`, a safe-integer `modelId` and, when present, a valid safe-integer `lastSelectedModelId`; otherwise the legacy mode routing applies. `lite` / `pro` / `max` remain routing tiers, conflicting current ids and unmapped ids stay unknown, and no lower-priced model is substituted.
- Auto keeps the label `auto`; routing tiers, unknown and conflicting ids keep an edition-qualified label. All use the `unpriced:catpaw` provider, which blocks automatic catalog pricing. Explicit user custom pricing still applies under the fork's pricing rules. `rateMultiplier` is a credit multiplier, never a token price.
- Model selection is session state, not per-message identity: changing a session's model relabels its earlier usage. That ceiling is inherent to the stored data.
- A changed source is replaced whole or not at all: a failed read keeps the last complete snapshot and logs a warning, a confirmed removal clears its rows, and a successful empty read is empty. Reads are bounded; a source over budget keeps its last complete snapshot.
- Concurrent scans share one lock so an older scan cannot overwrite a newer complete snapshot; without the lock, sources are still read but no cache is written.
- Changes to older days inside an existing database (deletion or model relabeling) reach history only at the next full reconciliation; today-only watch deltas cannot repair them.
- Observed real samples (four domestic, three overseas usage rows) satisfied the four-bucket identity with `cacheWrite` always zero. Nonzero cache write, tool/sub-agent rows and legacy runtime formats are covered only synthetically; do not present them as verified.
- The domestic Windows storage contract was verified statically through installer and `app.asar` inspection; the [issue reporter's real-machine evidence](https://github.com/Javis603/token-monitor/issues/715#issuecomment-6020857899) also confirms its paths, schema and 169 usage rows. The overseas Windows root is inferred from the product contract. Windows file-lock, WAL and SHM behaviour still lacks a real-machine check, as does the overseas Windows installer.
- Linux and WSL read no CatPaw source. Under a Windows host the root is app-data-relative, so a WSL scan would recount host usage.
- The vendor pin must carry the fork parser.

## Icons

`assets/icons/catpaw.svg` keeps the original 64×64 paw geometry and foreground colors with a transparent background. The outline becomes transparent separation so the same artwork stays recognizable when lists, the tray and the macOS widget render it in a single color.

## Verification

```bash
npm run verify
node scripts/verify-vendored-tokscale.js
node scripts/verify-vendored-tokscale-clients.js
```

The token-contract fixture covers a synthetic nonzero-cache-write row and applies only to darwin and win32. The release script checks every downloaded platform asset and is expected to run in CI. None of this stands in for real-machine behaviour: the parser's own tests live in the fork under `token_monitor::catpaw` (`cargo test -p tokscale-core token_monitor::catpaw`).
