# AGENTS.md

This is the single source of project guidance, shared by every coding agent (Claude Code, Codex, Cursor, …). `CLAUDE.md` is a Claude Code compatibility shim that just imports this file — edit **this** file, not `CLAUDE.md`.

## Commands

```bash
npm start          # launch the Electron widget (= npm run widget / npm run dev)
npm run hub        # start the Node hub on port 17321
npm run agent      # start the headless collector→hub agent
npm run agent:once # one-shot collect+post, then exit (useful for cron/launchd)
npm test           # run the node:test suite (node --test "tests/**/*.test.js")
npm run lint       # ESLint flat config (eslint.config.js)
npm run verify     # lint + test (single local entry point)
```

Automated verification is `npm run verify` (= `npm run lint && npm test`); CI (`.github/workflows/ci.yml`) runs lint + test on push/PR across Node 22 & 24. The toolchain (ESLint 10 + the node:test glob) needs Node 22.13+, which is why `engines.node` is `>=22.13.0` (Node 18 & 20 are both EOL as of 2026-06).

To dry-run the agent without posting: `node src/agent/agent.js --once --dry-run`.

## Architecture

Three runtime entry points share a single `src/shared/` library:

- **`src/electron/main.js`** — widget process. Owns the BrowserWindow, IPC, and chooses between *local* and *sync* mode based on whether `settings.hubUrl` is set.
- **`src/hub/server.js`** — Node HTTP hub. Stores device records in `data/devices.json`, exposes `/api/ingest`, `/api/stats`, `/api/stats/stream` (SSE).
- **`src/agent/agent.js`** — headless collector for machines without a widget. Same data path as the widget's sync-mode collector.
- **`worker/src/index.js`** — Cloudflare Worker hub that speaks the same protocol; the aggregation rules must stay portable (no Node built-ins in `usage.js`). The "Deploy to Cloudflare" button isolates `worker/` into a fresh repo, so the Worker may **not** import files above its own dir — its shared closure (`limits.js` / `usage.js` / `history.js` / `projectKey.js`) is vendored into `worker/src/shared/` by `npm run sync:worker` (`scripts/sync-worker-shared.js`). `src/shared/` stays the single source of truth; those copies are `@generated` (a CommonJS `package.json` marker scopes them back to CJS inside the ESM worker) and CI fails on drift. Edit `src/shared/`, never the copies, then re-run the sync.

Remote Hub update checks use `src/shared/hubBuildRegistry.json`, not the product version. The registry hashes the portable Hub core plus separate Node/Worker adapters, so a desktop-only release does not ask users to redeploy and a Node-only change does not stale the Worker. The emitted identity is a registered build marker, not runtime attestation of arbitrary downstream edits; UI and docs must describe malformed or divergent metadata as unrecognized rather than claiming every custom fork is detectable. After the final Hub/shared implementation is stable, run `npm run update:hub-build` once; the focused Hub-build test fails when the registered source closure is stale. Do not hand-edit generated Worker metadata.

### Collector pipeline (shared by widget and agent)

`src/shared/collector.js` is the only place that invokes `tokscale`. It:
1. resolves the platform binary from `@tokscale/cli-<platform>-<arch>` and falls back to the JS shim under Electron via `ELECTRON_RUN_AS_NODE=1`;
2. runs three `tokscale --json --client <csv> --group-by client,model` calls (today / month / since `allTimeSince`) on full ticks (startup / interval / manual) — serially on purpose: concurrent scans triple peak CPU/IO. Watch-triggered ticks instead scan only `--today` and derive month/allTime **exactly** via `applyPeriodDelta()` anchored to the last full scan (every tokscale period scan costs the same full-load+filter, so the win is 3 spawns→1; the delta is an identity for append-only logs, NOT an estimate; stale-date anchors force a full scan);
3. funnels output through the shared extractors in `src/shared/usage.js`, which defensively deep-walk tokscale's JSON shape (they never assume a fixed layout — that's why `tokenValue`/`detectClient` accept many key spellings);
4. watches the per-client data directories from `watchClientRootsForClients()` with chokidar (native events on every platform and in every mode; `resolveWatchUsePolling()` owns that default so entry points can't drift, and `TOKEN_MONITOR_WATCH_POLLING` overrides it in both directions) and debounces refreshes by `watchDebounceMs`. There is deliberately **no cooldown** — the product promises 3–5 s updates, so a mid-tick watch event re-arms the debounce timer instead of coalescing. A watch tick maps the changed paths back to their clients and scans only those partitions, unioned into a single `--today` scan rather than one per client; unknown or unattributed paths fall back to an all-client `--today` scan. The cursor/antigravity tokscale cache dirs are deliberately *not* watched — only our own `maybeSync*` calls write them, so watching them re-triggers forever — while antigravity's *source* roots (`selfSyncSourceRootsForClients()`) are the exception and are watched, because tokscale only reads them and an event there cannot close the loop. Self-sync throttling lives in `src/shared/selfSyncThrottle.js`, and its three tick selections are **not** interchangeable: `forceSelfSync` waits for nothing, `sourceSelfSync` only shortens the floor for the client whose source moved, and a tick's `todayOnly` decides scan scope on its own, so forcing a sync cannot downgrade a manual full scan into a warm one. The rest is commented where it happens; the invariant worth preserving from outside is that the floor and the catch-up deadline each stay a single function, since every divergence between copies of them has been a bug. Kernel watch-descriptor exhaustion (`ENOSPC`/`EMFILE`/`ENFILE`, a per-user budget shared with editors and hit first on Linux) arrives as an async watcher error that would otherwise stop event delivery silently, so it rebuilds the watcher on polling — deliberately sticky for the process, because a later rebuild would only rediscover the same exhausted budget.
5. on Windows, also scans usage from **running** WSL distros (`src/shared/wslUsage.js`). It registry-gates on `HKCU\…\Lxss` (so `wsl.exe` is never spawned without WSL — the inbox stub otherwise shows an interactive install prompt), lists running distros via `wsl.exe --list --running` (never auto-starts a stopped one), keeps homes containing tracked-client data, and runs `tokscale --home \\wsl$\<distro>\home\<user>` per home (serial, same CPU/IO reason as above). The bundle is merged into the Windows periods in `collectUsageOnce` **before** `deriveClientStatus` (so a WSL-only client still shows active); `mergePeriods`/`addPeriodInto` (in `usage.js`) do the additive sum. It refreshes on full ticks only and is frozen between them (`wslAnchor` in `startCollector`), so the Windows-only delta anchor stays exact and the chokidar watcher is **not** extended to WSL. Non-`win32` is a no-op. Default on, no setting.

### AI Tool Limits collector

Usage and limits have independent lifecycles under `src/shared/deviceRuntime.js`: `UsageRuntime` owns the tokscale collector, while `LimitsRuntime` owns its refresh timer, bounded cross-provider concurrency, per-provider latest-wins serial lanes, scoped account refreshes, finite probe deadlines, retry/backoff, and `lastGood` / `lastAttempt` retention. Credential changes refresh or clear only the affected limits lane and never restart usage; Cursor additionally forces one targeted usage sync because its tokscale cache is self-synced.

`limitsRefreshMode` (`fixed` | `adaptive`) is deliberately a separate setting from `limitsRefreshMs`, so the fixed intervals keep their exact previous meaning, a chosen interval survives a round trip through adaptive, and nothing doing arithmetic on `limitsRefreshMs` has to handle a sentinel. Adaptive shortens the interval from a window's measured burn rate; `limitsBurnRate.js` documents the control law and what it is not, and the scheduling constraints are commented where they are enforced. Two decisions there are worth stating once so they are not quietly reversed: `burn-rate` stays out of `COOLDOWN_BYPASS_REASONS` and carries no circuit breaker on top of the existing backoff, because a 429 is transient traffic control rather than proof that a provider is unsuited to adaptive polling; and local token usage is deliberately **not** a trigger, because a client's tokens may be billed to a third-party API key or endpoint rather than the subscription being metered, and quota can equally be consumed from another device or the web, so the correlation breaks in both directions.

`DeviceState` composes both outputs into the unchanged device wire record, buffering limits until usage exists and cold-start previews until a complete usage baseline exists; limits-only updates preserve the usage `updatedAt`. Provider dispatch starts in `src/shared/limitCollector.js`, with provider-specific implementations split between that file and `src/shared/*Limits.js`; shared normalization remains in `src/shared/limits.js`. The hub and Worker receive the composed record and never need provider credentials.

Outbound transport is chosen at the runtime boundary, not per provider: `src/electron/limitsFetch.js` gives the widget `src/shared/outboundFetch.js` when a proxy env is configured and Electron's `net.fetch` otherwise, so the OS proxy applies with no setup. Every widget provider call takes it — the collector's `deps.fetch` and the account-settings probes alike, since those gate whether a credential can be saved at all. Two things about that are easy to get wrong. `probeLimitProvider` injects a resolved `fetch` into every provider and `createOutboundFetch` returns an injected one untouched, so a provider's own env-proxy call is dead unless that lane builds its own deps; and a probe carrying its own transport (`node:https`, `claudeWebFetch`, a spawned CLI) inherits none of this. Chromium is also not a drop-in for undici — never give it a `Host` header (it rejects the request; sign the canonical host and let the transport derive the wire value), keep `credentials: 'omit'` so the default session's cookie jar cannot shadow a provider-managed `Cookie`, and know that an explicit cross-origin `Referer` carrying a path is cancelled unless that provider asks for a looser `referrerPolicy` itself.

Balance-style quotas are marked with `windows[].metric === 'credits'`: their headline value is money (`remaining` + `currency`), not a percentage. `src/shared/limitBalanceDisplay.js` is the single formatting/derivation entry point shared by Home, the tray and the limits page — key off that marker, never a provider whitelist. The meter percentage for a top-up balance (`amount / (amount + monthSpend)`) is a **display-layer derivation** and is deliberately kept out of the wire shape; don't push it back into a collector.

### Widget mode switching

`main.js` chooses the data path from `settings.hubMode` (`local` / `client` / `host`, set in the GUI's Multi-device Sync section). In `client` mode (a `hubUrl` is set) it: stops the local collector, opens an SSE stream to `/api/stats/stream`, and *also* runs a sync-collector to post this device's own usage. In `host` mode it additionally runs an embedded hub (`startEmbeddedHub()`) so other devices can connect. In `local` mode it runs only the local collector and emits stats over IPC to the renderer.

When both a widget and the headless agent run on the same machine, the widget's sync-collector backs off — it checks `data/agent.pid` (`pidFilePath()`) and skips posting if that PID is alive. This is the only coordination between them.

### Settings and credentials: env first, GUI overrides for widget

Configuration has two sources, and the widget splits its persisted GUI state by sensitivity:

1. **`.env` at project root** — read by `loadDotEnv()` in `src/shared/config.js` at the top of every entry file. Only assigns keys that aren't already in `process.env`, so real env vars (systemd / launchd / Docker) still win. `.env.example` documents the operator-facing settings intended for direct configuration, including connection/device settings, feature toggles, and provider credentials. Lower-level runtime knobs may still be accepted without being listed there; treat additions or removals from the documented env surface as compatibility changes and keep `.env.example` aligned with the code.
2. **Widget GUI** — Electron `userData/settings.json` stores preferences and account metadata; plaintext `userData/credentials.json` stores GUI-managed raw credentials with restrictive filesystem permissions (POSIX `0600`; Windows relies on the containing `userData` ACL). `readSettings()` merges both over `defaultSettings()` (which is seeded from env), while the main process sends a default-deny redacted view to the renderer. The only explicit renderer exceptions are the two Hub secrets required by the existing sync UI. The headless agent and standalone hub never read `credentials.json`; their credential flow remains CLI/env-based.

`CREDENTIAL_SETTING_PATHS` in `src/shared/credentialStore.js` maps fixed GUI credential settings. Add new fixed credentials there instead of creating provider-specific stores; dynamic account credentials such as MiMo cookies belong under a dedicated nested path in the same unified store and must remain metadata-only in the renderer. Expose any raw credential to the renderer only through an explicit allowlist. Legacy migration must write and verify the new store before stripping/deleting the old source; corrupt, unknown-version, or symlinked stores must never be replaced with an empty document. This store is deliberately local plaintext protected by filesystem permissions, not OS-backed encryption: it avoids Keychain/credential-manager prompts but does not protect against processes already running as the same OS user.

Per-setting precedence for the agent and hub: `CLI flag → env var (real or .env) → built-in default`. There is no JSON config file anymore — `config.local.json` was removed.

### Adding a tracked client

The default client CSV lives in **one** place: `DEFAULT_CLIENTS` in `src/shared/clientTracking.js` (`src/electron/main.js` and `src/agent/agent.js` both derive from it). But adding a *new* client means touching several spots that must all agree on the id:

| Touch point | Where |
|---|---|
| Default client list | `DEFAULT_CLIENTS` in `src/shared/clientTracking.js` |
| Source roots | the `add(...)` call in `clientSourceRoots()` (`src/shared/collector.js`) — one `[checkId, dir]`, or `[checkId, watchDir, sourcePath]` when tokscale reads one exact file. `clientWatchCandidates()` is only a projection of this table; nothing is declared there |
| Source check ids | every `checkId` above must be in `CLIENT_SOURCE_CHECK_IDS` (`src/shared/clientHealth.js`), kept alphabetical, then `npm run sync:worker` for the Worker copy. An id missing from that allowlist makes `normalizeClientHealth` drop the client's whole `checks` array, not just the unknown entry |
| XDG vs home-relative | mirror tokscale, do not guess: a root is XDG-derived only if `clients.rs` declares it `PathRoot::XdgData` or `scanner.rs` resolves it through the `dirs` crate. Those `dirs` lookups are invisible to `strings` on the binary and to `tokscale clients`, so read the Rust at the version tag (`tmp/tokscale`). Roots spelled as home-relative literals upstream must stay home-relative here |
| Name normalization | the `normalizeClientName()` branch in `src/shared/usage.js` |
| Renderer maps | `clientLabels` / `clientsWithIcon` / `KNOWN_CLIENTS` in `src/electron/renderer/app.js`; provider artwork in `src/electron/renderer/trayProviderIcons.js`; `VENDOR_ORDER` / `VENDOR_LABELS` in `themePresets.js`; `clientColors` in `usageCharts.js` |
| Discord RPC | `KNOWN_CLIENT_ASSETS` / `CLIENT_LABELS` in `src/electron/discordRpc.js` |
| Row icon CSS | the `.row-icon-<id>` rule in `src/electron/renderer/styles.css` |
| Icon assets | `assets/icons/<id>.svg` + `.github/assets/tools-icon/<id>.png` |
| WSL discovery | marker(s) in `WSL_DATA_MARKERS` **and** the marker→id mapping in `MARKER_CLIENTS` (`src/shared/wslUsage.js`) — use the exact roots tokscale reads, including alternate roots. A marker without a `MARKER_CLIENTS` entry attributes to nothing, so a WSL home holding only that client's data would be skipped |
| Docs & env examples | the supported-tools table in `README.md` and its translations (`README.*.md`) + the client CSV in `.env.example`. Every locale's prose tool/provider counts must match its own table — `tests/docs/readmeConsistency.test.js` fails on a stale count or a table that drifts between locales |
| Guard tests | the expected-client lists in `tests/shared/clientTracking.test.js` |

One caveat on top of the table:

- Self-synced clients (cursor/antigravity) additionally go in `SELF_SYNCED_CLIENTS`; parse-local clients must NOT.
- Targeted watch ticks make the client id a correctness surface, because the scan is keyed on it from two independent directions: `clientWatchCandidates()` decides which id a changed path maps to, and `normalizeClientName()` decides which id tokscale's rows land under. Three invariants keep them aligned — the id must be a fixed point of `normalizeClientName()` (so the partition a targeted scan writes is the one it cleared); every tokscale alias in `TOKSCALE_CLIENT_ALIASES` must normalize back to its parent id and be expanded by `tokscaleClientFilter()` (so targeting the parent still scans the alias, as with `antigravity` / `antigravity-cli`); and the filter must never emit `synthetic`. The first two are correctness: break either and a watch tick zeroes a client's partition, feeding a negative delta into month/allTime until the next full scan. The third is performance — `synthetic` makes tokscale enable *every* client, so the targeted scan silently degrades into a full one with correct numbers and none of the saving. Don't diagnose one as the other. `tests/shared/clientPartitionInvariants.test.js` enforces all three.
- Limits-only providers must keep `LIMIT_PROVIDER_IDS` in `src/shared/limitCollector.js` aligned with renderer `LIMIT_PROVIDERS`, account settings when applicable, tray artwork, and every README table. `LIMIT_PROVIDER_IDS` defines the new-install order; a changed default must not overwrite a saved custom order.

### Data flow contract

The hub stores normalized device records (`normalizeDeviceRecord` in `usage.js`) and aggregates on read (`aggregateDevices`). The wire shape between agent/widget and hub is whatever `collectUsageOnce()` returns — that function is the source of truth, and `docs/API.md` documents the full contract. The core is `{deviceId, hostname, platform, updatedAt, agentVersion, today, month, allTime}` (each period has `{totalTokens, costUsd, clients, clientCosts, models, modelCosts}`), plus attribution fields (`trackedClients`, `clientStatus`, `wslStatus`, `periodWindows`, `projectsEnabled`) and optional `osName` / `osVersion` / `agentRuntime` / `history` / `limits`. The Worker hub uses the exact same shapes.

### Subscriptions are hub-scoped, not device-scoped

Manually recorded subscriptions (`src/shared/subscriptionDisplay.js`) are the one thing a hub stores that is **not** part of a device record. A subscription describes an account, and `accountKey` is not stable across platforms — the collapse pass in `limits.js` exists precisely because the same OAuth login hashes differently on macOS and Windows — so per-device copies could not be deduped and a two-machine setup would double its own monthly total. `GET`/`PUT /api/subscriptions` therefore read and write one shared list per hub; a delete is a delete, with no tombstone needed.

`PUT` carries `baseUpdatedAt` and answers `409` when it does not match the stored document: this data exists nowhere else, so a device writing from a stale copy must not silently erase records added elsewhere. In the widget that token belongs to whoever built the list — the renderer sends back the version its edit was made on — and is never re-derived at write time. Hub reads and writes run in a per-hub lane, but ordering is not re-basing: a write queued behind a refresh that pulled in another device's records is refused, not quietly retargeted at the version that refresh left. In `local` mode the list lives in the widget's `settings.json`; in `client`/`host` mode that key is only the last-known cache, and writes attempted while the hub is unreachable are refused rather than applied locally (a local write would fork the shared list). The list is never part of `publicStats`.

Propagation is by version stamp, not by shipping the list: an accepted `PUT` broadcasts stats the way an ingest does, and every stats frame carries `subscriptionsUpdatedAt`. A device re-reads only when that disagrees with the copy it holds, so an edit lands on the other devices in seconds and the steady state costs nothing — there is deliberately **no periodic subscription read** behind it. Both stats paths feed the comparison: the stream while it is up, and the widget's own `/api/stats` read when it is not (that one is five minutes apart precisely while the stream is up, `restartTimer()`). Four traps. The Worker's `/api/public/stats` spreads the rest of `getStats()`, which is why the stamp is added by a separate `statsWithSubscriptionVersion()` that only the authenticated paths call — fold it back into `getStats()` and the one unauthenticated route both reads the money document and publishes whatever it found. A missing stamp must read as "no news", since that is also what a local collector's own stats look like. The version is compared *inside* the subscription lane rather than before it: only what an in-flight operation leaves behind can tell this device's own write (which lands the broadcast version itself, so nothing needs fetching) from another device's (where a read already in flight answers with the older document). And a failed catch-up must not be retried on every frame, since frames arrive on every ingest from every device — the same version is retried at most once a minute, while a version that moves is tried at once.

### Stale devices

A device is "stale" if `Date.now() - receivedAt > staleAfterMs` (default 10 min). Stale devices still appear in `/api/stats` with `stale: true`, and the renderer greys them out — this is intentional, not a bug.

## Conventions

- **Consider best practices first.** When picking an approach — library vs hand-roll, pattern vs custom, framework default vs override — start by checking the ecosystem convention, not by optimizing for "fewer deps" or "less code". If a hand-rolled solution is genuinely better, argue that *after* weighing the convention.
- **This project has external users.** Settings keys, env vars, CLI flags, hub endpoints, and the wire shape (`docs/API.md`) are compatibility surfaces — treat changes to them as breaking and think about migration. Internal code can still be refactored and renamed freely.
- **Don't add dependencies or new tooling without discussing it first** (in the issue or PR description).
- **Keep this file lean and current.** Document non-obvious constraints and gotchas, not descriptions the code already makes obvious. Avoid hardcoded counts and exhaustive lists (prefer a command like `ls src/shared/` over a hand-maintained one); verify claims against the code before writing them; delete anything that has gone stale — an outdated note is worse than none.

### Commit messages

Format: `<type>(<scope>): <subject>` — conventional-commit types (`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `test` / …), with a scope when the change targets a clear subsystem (`fix(hermes):`, `fix(collector):`, `feat(limits):`); leave it off for cross-cutting or general changes. When a change belongs to a single provider, scope it by that provider (`fix(opencode):`, `fix(codex):`) rather than by the subsystem it happens to live in. Aim for a subject ≤ ~72 chars that describes the actual change. Add a **body** only when the diff doesn't make the *why* obvious — rationale, rejected alternatives, behaviour-preserving notes, linked issues; trivial changes stay single-line. Write body paragraphs as continuous lines, not hard-wrapped.

**Do:**

```
fix(dashboard): balance stat card widths
feat(wsl): scan usage from running WSL distros
docs(i18n): add Japanese README
```

**Don't** — vague subjects, or internal review/agent jargon (`P0`/`P1`, "review findings", "hardening pass"):

```
fix: address P0 review findings   ❌
fix: hardening pass round 2       ❌
fix: various improvements         ❌
```

Never add an AI `Co-Authored-By` trailer. **Do** keep the genuine human `Co-authored-by:` trailer on a multi-author squash (e.g. a maintainer follow-up on a contributor PR) and keep the `(#NN)` PR-number suffix GitHub appends to squash subjects.

### Pull requests

- PR titles follow the commit-message convention above — they become the squash-merge subject.
- In the description: summarize the behaviour change, note the commands you ran (`npm run verify` at minimum), attach screenshots/GIFs for UI changes, and link the related issue.

### Authoring GitHub content via `gh`

Write PR/issue bodies and comments to a file and pass it, rather than inline heredocs: `gh issue comment --body-file <path>`, `gh api -X PATCH … -F body=@<path>`. Inline `--body "$(cat <<EOF … EOF)"` mangles backtick escaping and renders as a literal `` \` `` in GitHub markdown. Same spirit for prose: write paragraphs as continuous lines and let GitHub wrap them — don't hard-wrap at 80 columns.
