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
| Client identity | one entry in `CLIENT_CATALOG` (`src/shared/clientCatalog.js`), inserted at its display position (array order): id, label, `defaultTracked`, `locallyParsed`. Tracking lists and the renderer's labels derive from it; Discord's `CLIENT_LABELS` still carries its own |
| Client-specific code | only when the client parses or syncs something itself (transcript readers, path resolvers, the self-sync a cache-backed client needs): `src/shared/providers/<id>/`, the same folder the limits provider of that id would use. Most tracked clients need none — tokscale parses them end to end, so they are catalog, roots, icon and README only |
| Session metadata | only for what the scan cannot answer — titles for most clients, Codex's background-review `sessionKind`, the live `contextTokens`/`contextWindow` pair: one entry in `src/shared/sessionMetadata.js` returning `Map<sessionId, {…}>`, with discovery, parsing and caching kept in `src/shared/providers/<id>/`. Timestamps and project attribution already arrive with the scan. The context pair comes only from the client's own transcript (never guessed from a model name) and is read only through `shouldReadSessionContext()`; that gate and pair validation stay in `src/shared/sessionContext.js` so providers cannot disagree |
| Source roots | for a home-relative directory identical on the host and under WSL, declare `{marker, client, hostCheckId}` once in `src/shared/clientSourceRegistration.js` and project it through `clientSourceRoots()` (`src/shared/collector.js`). For platform/env-dependent roots, alternate paths or exact files, use an explicit `add(...)` entry in the collector: `[checkId, dir]` or `[checkId, watchDir, sourcePath]`. `clientWatchCandidates()` remains a projection, not another declaration |
| Source check ids | every `checkId` above must be in `CLIENT_SOURCE_CHECK_IDS` (`src/shared/clientHealth.js`), kept alphabetical, then `npm run sync:worker` for the Worker copy. An id missing from that allowlist makes `normalizeClientHealth` drop the client's whole `checks` array, not just the unknown entry |
| XDG vs home-relative | mirror tokscale, do not guess: a root is XDG-derived only if `clients.rs` declares it `PathRoot::XdgData` or `scanner.rs` resolves it through the `dirs` crate. Those `dirs` lookups are invisible to `strings` on the binary and to `tokscale clients`, so read the Rust at the version tag (`tmp/tokscale`). Roots spelled as home-relative literals upstream must stay home-relative here |
| Name normalization | the `normalizeClientName()` branch in `src/shared/usage.js` |
| Presentation | one entry in `VENDOR_PRESENTATION` (`src/shared/vendorPresentation.js`) at the client's catalog position: its brand `color`, `icon` / `mask` / `trayIcon` only when the artwork is not `assets/icons/<id>.svg`, and `widgetColor` or `widgetInk` when the brand colour would be too dark on the macOS widget. Chart colours, the appearance picker, row marks, tray artwork and the widget's palette all derive from it. The table is not a client list — it also holds model vendors and limits-only marks — so the label comes from the catalog and the entry carries none |
| Discord RPC | `KNOWN_CLIENT_ASSETS` / `CLIENT_LABELS` in `src/electron/discordRpc.js` |
| Icon assets | `assets/icons/<id>.svg` + `.github/assets/tools-icon/<id>.png` by convention. A client that reuses a vendor mark has no file of its own (hermes, mimo, zcode); the entry's `icon` is the mapping |
| WSL discovery | add `{marker, client}` in `src/shared/clientSourceRegistration.js` using the exact Linux home-relative path tokscale reads, including alternate roots. `WSL_DATA_MARKERS` and `MARKER_CLIENTS` in `src/shared/wslUsage.js` derive from that entry; only add `hostCheckId` when the same path is also a host directory. Keep file sources, platform/env variants and alternate-root host watchers explicit in the collector |
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

Provider identity lives in **one** place: `LIMIT_PROVIDER_CATALOG` in `src/shared/limits/providers.js`. The catalog order is the new-install order; a changed default must not overwrite a saved custom order. A tracked client is something tokscale counts tokens for, a limits provider is an account whose quota we read, and only some ids are both — the two catalogs and checklists are separate. Everything below is either a hand-wired registration point that must agree with that id, or a provider-specific surface to add only where it applies.

| Touch point | Where |
|---|---|
| Provider identity | one entry in `LIMIT_PROVIDER_CATALOG` (`src/shared/limits/providers.js`), inserted at its fresh-install position (array order): id, label, and `settingsLabel` only when it differs. `LIMIT_PROVIDER_IDS` / `LIMIT_PROVIDER_LABELS` derive from it |
| Collection | `fetchLimits` in `src/shared/providers/<id>/limits.js`, bound by the static `src/shared/limits/registry.js` alongside the provider's account declaration; `src/shared/limits/collector.js` consumes the registry fetchers |
| Settings & credentials | `fields` in the require-free `src/shared/providers/<id>/account.js`; `src/electron/limits/accountSettings.js` derives fixed credential paths, settings keys/config, main-process projection and normalization. Automatic providers that store nothing (antigravity, grok, kiro) declare no credential field |
| Account UI | A pasted credential — one key, a cookie, or a few fields with a region select — is declared as `form` and `status` in `account.js`: main projects a redacted, serializable form DTO (`limitAccountFormsForRenderer()`), and `renderer/limits/accountPanels.js` builds the panel with no provider-specific HTML or renderer handlers. `form.fields` lists the controls (`password`, `text`, `textarea` or `select`); a field is optional unless `required` (a draft still needs one secret filled in), and `secret` unless it is a select — secret fields are what Clear empties and what the draft forgets after a save, `prefill` shows a stored plain-text value again, a select's `saveOnChange` stores it as soon as it changes, and `clears` names what that change invalidates. Placement is two block lists: `top` stays visible once the account is linked (a region select), `manual` is the paste panel that hides; a block is a `note` (optionally shown only `when` a select holds certain values), a numbered `steps` list, or a `field`. A step part that follows a select is `{ code: { byField, values } }`. `openUrl` is `{ url }`, `{ byField, urls, default }` for a page that follows a select, or `{ byStatus, urls, default }` for one that follows the last successful poll (MiniMax's region); every URL it can return must pass the provider's `urlPolicy`, which `assertAccountForm` checks at load. A form with one field may still use the shorthand `field` / `input` / `noteKey` / `steps` / `url`. `kind: 'custom'` keeps a hand-built panel (kimi's two lanes, volcengine's paired keys) on the same save path; its nodes live in `index.html` with an entry in `LIMIT_PROVIDER_ACCOUNT_NODES` and `externalLimitAccountConfig` (`app.js`). Every form saves through `limits:saveCredential` (`src/electron/limits/credentialCommands.js`): main normalizes the draft, probes it with the provider's own fetcher, and stores it — selecting the provider in the same `settings:update` write — unless the draft is incomplete, fails normalization, or the fetcher reported `unauthorized`. Throttled, unreachable or malformed answers say nothing about the credential, so it is saved and the panel says it could not be confirmed yet. Which HTTP answers mean a bad credential is therefore the fetcher's classification; if the provider's 404 or 403 means a wrong key or account, report `unauthorized` there so the save check and the account pill agree. The probe gets a fresh runtime state and bypasses validation caches; a fetcher with persistent bookkeeping must skip it when `deps.probe` is set, and `rememberProbe: { fn, field }` hands a confirmed probe to the provider (Ollama answers its next poll from it rather than asking a rate-limited page twice). Secret fields missing from the draft are blanked for the probe, and the probe runs with an empty env, so neither a stored sibling credential nor a process variable can vouch for a bad one (Kimi's env lanes read `deps.env`). Any later settings write that touches the form's fields retires the whole probe — even a stale rejection lands as `superseded`, never as the verdict. `form.messages` optionally replaces the shared `required`, `invalidFormat` and `rejected` messages with provider-specific guidance. The message line is renderer state (`state.accountPanelMessages`), not DOM, so a stats push does not wipe it. Keep source-specific discovery and status in the declaration, not the DTO. Automatic providers can use `LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS`; display toggles belong in `LIMIT_PROVIDER_SETTINGS`. Login and profile panels keep provider-specific auth, identity and profile operations; their status/error/progress/expansion chrome uses `renderer/limits/accountShell.js`, while `LIMIT_PROVIDER_ACCOUNT_NODES` maps hand-built groups to their status pills. Catalog labels, settings-row search/order and capability/source tags remain in the catalog, renderer list and `providerPresentation.js` respectively |
| Manual panel | A custom **plain** `#<id>ManualPanel` in `index.html` needs `initSettingsAnimationWrappers()` (`app.js`) and matching selectors in `styles.css`; generic panels use `.credential-manual-panel` in both places. An **add-form** panel (`class="opencode-add-form"`) instead declares `accordion-animated-container` on its own `#<id>ManualDetails` / `#<id>AddDetails` child and must stay out of the JS list |
| Capability tags & source labels | `CAPABILITY_TAGS` in `src/electron/renderer/limits/providerPresentation.js` is required, and does not error when missing — the settings row simply renders without the tags that say how the provider is collected. `PROVIDER_SOURCE_LABELS` in the same file is an override, worth adding only where the generic source label is wrong for that provider, since `limitProviderSourceLabel` falls back to it |
| Marks | an entry in `VENDOR_PRESENTATION` (`src/shared/vendorPresentation.js`); a provider that is also a tracked client or model vendor already has one. Give it a `label` and `color` if it should appear in the appearance picker, or only an `id` for a mark-only entry. `rowIconMasks.js` installs its `.row-icon-<id>` mask, shared by both call sites: `renderLimitProviderMark` sizes the Limits list mark with `.limit-icon`, `iconKindFor` builds a breakdown row from it directly. A provider whose mark must differ between the two needs an explicit `.limit-icon.row-icon-<id>` override in `styles.css` — Grok is the only one, because the tracked client reuses the vendor mask. The mask paints `currentColor`, so an id without an entry renders a solid square. The macOS widget reads names, colours and artwork from its snapshot and needs no Swift edit |
| Icon assets | a file reachable through the entry's `icon` / `mask` / `trayIcon`. `assets/icons/<id>.svg` + `.github/assets/tools-icon/<id>.png` is the convention, not a requirement: shared and vendor artwork is normal (mimo and zaiteam have no file of their own) and one README icon can stand for several provider ids. `trayIcon` is only for menubar-optimized tray artwork |
| i18n | `settings.<id>.*` keys in every locale in `i18n.js`; automatic providers use `settings.limits.connection.<id>` instead |
| Docs & env examples | the supported-tools table in `README.md` and its translations, plus `.env.example` when the provider takes a credential; a note here for non-obvious identity, fallback or security rules |

The registry is explicit, not a dynamic require: add one `registerProvider(...)` line to `src/shared/limits/accounts.js`, pairing the account leaf with a lazy loader for its limits module; `registry.js` binds it and needs no edit. `fetchLimits` must accept the injected transport. The account leaf stays require-free so credential storage can read it without loading provider probes; setup URLs must pass the main-process allowlist. Most registration surfaces have catalog-backed CI guards (`grep LIMIT_PROVIDER_IDS tests/`); keep the i18n keys present in every locale and test any custom panel shape separately. Source-label overrides are deliberately optional because the generic label is usually correct.

Normalize results through the shared limits core, keep display-only derivations out of the wire shape, use the injected transport unless the note documents a custom one (`docs/architecture.md` → Outbound transport), and never expose raw credentials to the renderer.

`limits/providers.js` is in the portable Hub core, so renaming a provider stales the Hub build marker even though nothing the Hub runs changed — the exception to "a desktop-only release does not ask users to redeploy". Accepted rather than worked around: adding or reordering a provider moves the marker wherever the labels live, and so does a rename that touches only the label. Run `npm run update:hub-build` once the shared change is final.

## Where provider code lives

One folder per vendor, not per technical role: `src/shared/providers/<id>/`, with app-layer code in `src/electron/providers/<id>/`. An id that is both a tracked client and a limits provider keeps both sides in the same folder. Helpers shared by several providers go in `src/shared/limits/providerHelpers.js`; global modules (`credentialStore.js`, `outboundFetch.js`) stay where they are. Some provider files are in the portable Hub core (`grep providers/ scripts/hub-build-manifest.js`), which is why `WORKER_SHARED_MODULES` holds paths relative to `src/shared/`.
