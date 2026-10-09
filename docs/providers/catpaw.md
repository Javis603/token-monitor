---
summary: "CatPaw local assistant usage, edition roots, model attribution, and bundled-fork requirements."
ids: [catpaw]
read_when:
  - Changing CatPaw source discovery, watching, or token accounting
  - Updating the CatPaw parser or bundled binary
---

# CatPaw

## Identity and ids

`catpaw` is one opt-in, fork-only tracked client for the domestic and overseas assistant apps. Region, account database and conversation identities remain distinct inside that client. There is no limits provider or credential flow. IDE integration is deferred.

## Data sources

The fork owns SQLite parsing; Token Monitor discovers the same roots for watching and health. macOS uses `~/Library/Application Support/{catpaw-moon,catpaw-overseas}`; Windows uses the native roaming app-data directory with those same edition names. The existing Koffi dependency queries `FOLDERID_Profile` and `FOLDERID_RoamingAppData` through [SHGetKnownFolderPath](https://learn.microsoft.com/en-us/windows/win32/api/shlobj_core/nf-shlobj_core-shgetknownfolderpath), matching Rust's `dirs` lookup rather than trusting an independently overwritten `APPDATA`. Explicit homes and a redirected Windows `HOME` follow the fork's `PathRoot::AppData` rules instead of reading the host profile. Linux and WSL scans exclude CatPaw. Cold-start trust uses the source platform; the device's `darwin-arm64` / `win32-x64` display value is not a source platform.

Only immediate `catpaw-memory-<scope>.db` files with a nonempty ASCII alphanumeric/underscore/hyphen scope are eligible; exact `anon` is excluded. Historical account databases are included. The parser reads projected usage from `ui_sdk_messages` and model selection from `sessions`; it does not export message bodies, titles or account credentials.

The observed assistant usage fields are disjoint: `promptTokens`, `completionTokens`, `cacheReadTokens`, `cacheWriteTokens`; their sum must equal `totalTokens`. Reasoning and one-hour cache-write tokens are not independently persisted and remain zero. Invalid counts, schema changes and incomplete reads fail the whole database snapshot and retain its last complete cached rows; confirmed database removal removes those rows.

The fork holds a stable `catpaw.lock` across cache loading, source scans and atomic publication, so concurrent CLI processes cannot replace a newer complete snapshot with an older one. If the lock is unavailable, source reads remain enabled but cache writes are disabled. A competing scan waits for the lock holder to exit or release it.

## Source precedence

Both editions are scanned together. There is no current-account-only filter and no region precedence. The source set participates in the collector anchor fingerprint: adding/removing an account database forces all periods and history to refresh, rather than applying today's difference to historical totals.

Database removal excludes its rows from the parser and collector snapshots. The widget's default session archive still retains previously captured usage, as for sibling clients; source removal does not clear that archive. With session archiving paused, the displayed periods follow the remaining live databases.

The watcher keeps the edition root for new-account discovery and accepts only direct database/WAL/SHM family names. Authentication stores, application logs and nested directories are pruned. Repeated read-only scans of an active WAL fixture changed SHM timestamps on all three scans while database/WAL hashes and timestamps stayed unchanged; SHM events therefore use the existing self-watch suppression. Database and WAL events still trigger collection.

## Invariants and known gaps

- Model ids are edition-specific. A valid persisted model selection takes precedence over the legacy id, with initial selection as fallback. Auto, routing tiers, unknown ids and inconsistent selections remain unpriced rather than guessing a catalog model.
- Model selection is session state, not historical per-message attribution; changing a session's model can relabel historical usage. Rate multipliers are not API prices.
- The account-set fingerprint covers whole-database additions/removals. Changes to older days within an existing database (including deletion or model relabeling) reach historical periods at the next full reconciliation; today-only watch deltas cannot repair those older days.
- Workspace, session title, context occupancy and IDE usage are not provided by this prototype.
- macOS domestic and overseas app bundles and Windows domestic installer were inspected. Overseas Windows compatibility is inferred from the shared product contract, not verified on a Windows runtime. Custom Electron user-data directories are not supported.
- The repository's current binary pin predates the CatPaw parser. Wiring can be validated against the local fork build, but production support requires publishing that fork build and updating the real manifest checksums. Do not substitute local hashes or claim the existing pinned binary supports CatPaw.
- Runtime capability fallback probes fork clients individually after a rejected batch, so a pre-CatPaw fork keeps its supported Proma/Qoder CN clients. The packaging gate still requires every registered client.

## Icons

The official app bundle supplies `dist/assets/brand-logo-scXAN_6K.svg` inside `app.asar`, extracted with `@electron/asar`, and `Contents/Resources/icon.png`. `assets/icons/catpaw.svg` preserves the official vector; `catpaw-mask.svg` preserves its two white paw-fill paths; the original black outline becomes transparent separation through a luminance mask, and the original accent strokes remain. It removes the gradient tile without redrawing the paws. Both SVGs keep the original `64 × 64` viewBox and intrinsic dimensions. Deep/light previews cover the actual 10–12 px row marks, 20 px macOS tray height and larger picker sizes. The bundle also contains an older `logo.svg` and a different `catpaw-icon.svg`; the selected brand SVG matches the installed app icon. Domestic macOS 2026.0923.1851 and overseas 2026.0929.1522 PNGs have the same SHA-256: `dbe6abb49354c0de1c08173fa61cb7b908e38dc718b410fccb1c606d57bbdc10`. No website image is needed.

## Verification

Run `npm run verify` and, after updating the bundled fork, `node scripts/verify-vendored-tokscale.js`. The latter checks a real SQLite fixture through the CLI and the token/session fields consumed by Token Monitor; CatPaw fixtures apply only to macOS and Windows. Parser tests live in the fork under `token_monitor::catpaw`.
