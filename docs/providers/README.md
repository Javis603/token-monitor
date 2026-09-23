---
summary: "Provider-note routing, note conventions, and the registration checklists for tracked clients and limits providers."
read_when:
  - Changing code under src/shared/providers or src/electron/providers
  - Adding or renaming a tracked client or limits provider
  - Writing or restructuring a provider note
---

# Provider notes

This directory holds focused notes for providers with non-obvious data sources, identity rules, fallbacks, or security boundaries, plus the registration checklists every new integration follows. The notes supplement the code; they do not replace it.

## Finding the note for an id

Every note declares the catalog ids it covers in its front matter, so routing never depends on the filename:

```bash
grep -lE '^ids:.*[[, ]<id>[],]' docs/providers/*.md
```

A product family shares one note when splitting it would hide a coupled contract — `droid.md` covers both the `droid` tracked client and the `factory` limits provider. If no note claims an id, this README and the code/tests are authoritative; do not create an empty placeholder. `tests/docs/providerGuidance.test.js` fails when a note claims an id that is in neither catalog (so a rename cannot leave a note pointing at nothing), when two notes claim the same id, or when a filename is not one of its own ids.

Read the matching note before changing that provider, and update it in the same change when its documented contract moves.

## Writing a note

A note is warranted when a provider has one or more of these properties:

- separate usage, session and limits data planes that must not be conflated;
- non-trivial account identity or cross-device aggregation;
- ordered credential, endpoint or process fallbacks;
- local file parsing with bounded reads, caches or privacy constraints;
- a transport or security boundary that differs from the shared limits behaviour;
- multiple provider/client ids representing one product family.

Do not create a page that merely lists an endpoint or repeats a small `limits.js`. Keep cross-provider runtime rules in `docs/architecture.md`; do not repeat them in each note.

Front matter carries `summary`, `ids` (an inline list of catalog ids) and `read_when` (situations, not file lists). Sections are written only where they apply, in this order, so notes read the same way:

1. **Identity and ids** — which ids exist, which is the tracked client and which the limits provider, and why.
2. **Data sources** — where usage, session metadata and limits each come from, and which one is authoritative for what.
3. **Source precedence** — ordered fallbacks, and which failures may or may not fall through.
4. **Credentials and transport** — storage, renderer exposure, and any transport that does not inherit the shared one.
5. **Invariants and known gaps** — what must not be "fixed", and what is deliberately unsupported.
6. **Verification** — the focused `node --test …` command for the provider's own tests, and any manual checks that tests cannot cover.

## Adding a tracked client

Tracked-client identity lives in `CLIENT_CATALOG`, but a new client touches several spots that must all agree on the id:

| Touch point | Where |
|---|---|
| Client identity | one entry in `CLIENT_CATALOG` (`src/shared/clientCatalog.js`), inserted at its display position (array order): id, label, `defaultTracked`, `locallyParsed`. Tracking lists and the renderer's labels derive from it; Discord's `CLIENT_LABELS` and `themePresets`'s `VENDOR_LABELS` still carry their own |
| Client-specific code | only when the client parses or syncs something itself (transcript readers, path resolvers, the self-sync a cache-backed client needs): `src/shared/providers/<id>/`, the same folder the limits provider of that id would use. Most tracked clients need none — tokscale parses them end to end, so they are catalog, roots, icon and README only |
| Session metadata | only for what the scan cannot answer — titles for most clients, Codex's background-review `sessionKind`, the live `contextTokens`/`contextWindow` pair: one entry in `src/shared/sessionMetadata.js` returning `Map<sessionId, {…}>`, with discovery, parsing and caching kept in `src/shared/providers/<id>/`. Timestamps and project attribution already arrive with the scan. The context pair comes only from the client's own transcript (never guessed from a model name) and is read only through `shouldReadSessionContext()`; that gate and pair validation stay in `src/shared/sessionContext.js` so providers cannot disagree |
| Source roots | the `add(...)` call in `clientSourceRoots()` (`src/shared/collector.js`) — one `[checkId, dir]`, or `[checkId, watchDir, sourcePath]` when tokscale reads one exact file. `clientWatchCandidates()` is only a projection of this table; nothing is declared there |
| Source check ids | every `checkId` above must be in `CLIENT_SOURCE_CHECK_IDS` (`src/shared/clientHealth.js`), kept alphabetical, then `npm run sync:worker` for the Worker copy. An id missing from that allowlist makes `normalizeClientHealth` drop the client's whole `checks` array, not just the unknown entry |
| XDG vs home-relative | mirror tokscale, do not guess: a root is XDG-derived only if `clients.rs` declares it `PathRoot::XdgData` or `scanner.rs` resolves it through the `dirs` crate. Those `dirs` lookups are invisible to `strings` on the binary and to `tokscale clients`, so read the Rust at the version tag (`tmp/tokscale`). Roots spelled as home-relative literals upstream must stay home-relative here |
| Name normalization | the `normalizeClientName()` branch in `src/shared/usage.js` |
| Renderer maps | `clientsWithIcon` in `src/electron/renderer/app.js` — deliberately not catalog-derived: it also holds model-vendor ids and (via `limitMarksWithIcon`) limits marks, so it is an icon table, not a client list; provider artwork in `src/electron/renderer/trayProviderIcons.js`; `VENDOR_ORDER` / `VENDOR_LABELS` in `themePresets.js`; `clientColors` in `usageCharts.js` |
| Discord RPC | `KNOWN_CLIENT_ASSETS` / `CLIENT_LABELS` in `src/electron/discordRpc.js` |
| Row icon CSS | the `.row-icon-<id>` rule in `src/electron/renderer/styles.css` |
| Icon assets | `assets/icons/<id>.svg` + `.github/assets/tools-icon/<id>.png` by convention. A client that reuses a vendor mark has no file of its own (hermes, mimo, zcode); the `.row-icon-<id>` rule is the mapping |
| WSL discovery | marker(s) in `WSL_DATA_MARKERS` **and** the marker→id mapping in `MARKER_CLIENTS` (`src/shared/wslUsage.js`) — use the exact roots tokscale reads, including alternate roots. A marker without a `MARKER_CLIENTS` entry attributes to nothing, so a WSL home holding only that client's data would be skipped |
| Docs & env examples | the supported-tools table in `README.md` and its translations (`README.*.md`) + the client CSV in `.env.example`. Every locale's prose tool/provider counts must match its own table — `tests/docs/readmeConsistency.test.js` fails on a stale count or a table that drifts between locales |
| Guard tests | the expected-client lists in `tests/shared/clientTracking.test.js`, plus the pinned CSVs in `tests/shared/clientCatalog.test.js` (they guard a persisted-settings surface, so update them deliberately) |

Self-synced clients (cursor/antigravity) additionally go in `SELF_SYNCED_CLIENTS`; parse-local clients must NOT. Explain source roots versus generated cache roots in the provider note so watch behaviour stays loop-free.

### Partition invariants

Targeted watch ticks make the client id a correctness surface, because the scan is keyed on it from two independent directions: `clientWatchCandidates()` decides which id a changed path maps to, and `normalizeClientName()` decides which id tokscale's rows land under. Three invariants keep them aligned:

1. the id must be a fixed point of `normalizeClientName()` (so the partition a targeted scan writes is the one it cleared);
2. every tokscale alias in `TOKSCALE_CLIENT_ALIASES` must normalize back to its parent id and be expanded by `tokscaleClientFilter()` (so targeting the parent still scans the alias, as with `antigravity` / `antigravity-cli`);
3. the filter must never emit `synthetic`.

The first two are correctness: break either and a watch tick zeroes a client's partition, feeding a negative delta into month/allTime until the next full scan. The third is performance — `synthetic` makes tokscale enable *every* client, so the targeted scan silently degrades into a full one with correct numbers and none of the saving. Don't diagnose one as the other. `tests/shared/clientPartitionInvariants.test.js` enforces all three.

## Adding a limits provider

Provider identity lives in **one** place: `LIMIT_PROVIDER_CATALOG` in `src/shared/limitProviders.js`. The catalog order is the new-install order; a changed default must not overwrite a saved custom order. A tracked client is something tokscale counts tokens for, a limits provider is an account whose quota we read, and only some ids are both — the two catalogs and checklists are separate. Everything below is either a hand-wired registration point that must agree with that id, or a provider-specific surface to add only where it applies.

| Touch point | Where |
|---|---|
| Provider identity | one entry in `LIMIT_PROVIDER_CATALOG` (`src/shared/limitProviders.js`), inserted at its fresh-install position (array order): id, label, and `settingsLabel` only when it differs. `LIMIT_PROVIDER_IDS` / `LIMIT_PROVIDER_LABELS` derive from it |
| Collection | an entry in `providerFetchers()` (`src/shared/limits/collector.js`) plus the implementation in `src/shared/providers/<id>/limits.js` |
| Settings & credentials | `LIMIT_PROVIDER_SETTING_KEYS` (`src/electron/runtimeConfig.js`) and, for a fixed GUI credential, `CREDENTIAL_SETTING_PATHS` (`src/shared/credentialStore.js`). Automatic providers that store nothing (antigravity, grok, kiro) are in neither |
| Account UI | `LIMIT_PROVIDER_ACCOUNT_GROUP_IDS`, `LIMIT_PROVIDER_ACCOUNT_STATUS_IDS`, `LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS` and — only for display toggles — `LIMIT_PROVIDER_SETTINGS`, all in `src/electron/renderer/app.js`, with the `#<id>AccountGroup` / `#<id>AccountStatus` nodes they name in `index.html`. Every provider needs an account group **or** a connection-detail key |
| Manual panel | `#<id>ManualPanel` in `index.html`, in one of two shapes that must not be mixed: a **plain** panel animates through `initSettingsAnimationWrappers()` (`app.js`) and must also be in the two `#…ManualPanel` selector lists in `styles.css`; an **add-form** panel (`class="opencode-add-form"`) instead declares `accordion-animated-container` on its own `#<id>ManualDetails` / `#<id>AddDetails` child and must stay out of the JS list, which is why `cursorSettingsLayout.test.js` asserts some ids are absent |
| Capability tags & source labels | `CAPABILITY_TAGS` in `src/electron/renderer/limitProviderPresentation.js` is required, and does not error when missing — the settings row simply renders without the tags that say how the provider is collected. `PROVIDER_SOURCE_LABELS` in the same file is an override, worth adding only where the generic source label is wrong for that provider, since `limitProviderSourceLabel` falls back to it |
| Marks | one `.row-icon-<id>` rule in `styles.css`, shared by both call sites: `renderLimitProviderMark` sizes the Limits list mark with `.limit-icon` and takes the mask from that rule, `iconKindFor` builds a breakdown row from it directly. A provider whose mark must differ between the two needs an explicit `.limit-icon.row-icon-<id>` override — Grok is the only one, because the tracked client reuses the vendor mask. The rule paints `currentColor` through a mask, so an id without one renders a solid square |
| Icon assets | a mark reachable through the `.row-icon-<id>` rule and the tray resolver. `assets/icons/<id>.svg` + `.github/assets/tools-icon/<id>.png` is the convention, not a requirement: shared and vendor artwork is normal (mimo and zaiteam have no file of their own) and one README icon can stand for several provider ids. `SPECIAL_ICON_SOURCES` (`trayProviderIcons.js`) is only for menubar-optimized or shared tray artwork |
| macOS widget | an explicit `case` in `WidgetFormat.provider` (`native/macos/TokenMonitorWidget/WidgetViewModel.swift`) — kept complete rather than leaning on `default` |
| i18n | `settings.<id>.*` keys in every locale in `i18n.js`; automatic providers use `settings.limits.connection.<id>` instead |
| Docs & env examples | the supported-tools table in `README.md` and its translations, plus `.env.example` when the provider takes a credential; a note here for non-obvious identity, fallback or security rules |

Most of that table is asserted from the catalog, so a provider that misses one of those points fails CI rather than shipping — `grep LIMIT_PROVIDER_IDS tests/` shows which. What it does not cover fails silently: the manual-panel shapes, where a missing registration and a correct omission look identical from the id lists alone, and the i18n keys. The source-label overrides are deliberately left out, because falling back to the generic label is usually the right answer.

Normalize results through the shared limits core, keep display-only derivations out of the wire shape, use the injected transport unless the note documents a custom one (`docs/architecture.md` → Outbound transport), and never expose raw credentials to the renderer.

`limitProviders.js` is in the portable Hub core, so renaming a provider stales the Hub build marker even though nothing the Hub runs changed — the exception to "a desktop-only release does not ask users to redeploy". Accepted rather than worked around: adding or reordering a provider moves the marker wherever the labels live, and so does a rename that touches only the label. Run `npm run update:hub-build` once the shared change is final.

## Where provider code lives

One folder per vendor, not per technical role: `src/shared/providers/<id>/`, with app-layer code in `src/electron/providers/<id>/`. An id that is both a tracked client and a limits provider keeps both sides in the same folder. Helpers shared by several providers go in `src/shared/limits/providerHelpers.js`; global modules (`credentialStore.js`, `outboundFetch.js`) stay where they are. Some provider files are in the portable Hub core (`grep providers/ scripts/hub-build-manifest.js`), which is why `WORKER_SHARED_MODULES` holds paths relative to `src/shared/`.
