---
summary: "Cross-runtime architecture contracts: entry points, the collector pipeline, limits runtime, mode switching, configuration and credentials, the wire contract, Hub subscriptions and generated state."
read_when:
  - Changing boundaries shared by the widget, agent, Hub or Worker
  - Changing collector scanning, watching, self-sync, WSL or subprocess lifecycle
  - Changing limits scheduling, outbound transport or balance display
  - Changing the device wire record, Hub subscriptions or stale-device handling
  - Changing shared configuration, credential storage or renderer redaction
---

# Architecture

Cross-runtime decisions that one subsystem can break without noticing. Each section states the contract and why it holds; the mechanics are commented in the file named. Provider-specific behaviour belongs in `docs/providers/`.

## Entry points and the Worker boundary

`src/electron/main.js` (widget), `src/agent/agent.js` (headless collector) and `src/hub/server.js` (Node Hub: `/api/ingest`, `/api/stats`, `/api/stats/stream`) share `src/shared/`. `worker/src/index.js` is a Cloudflare Worker Hub speaking the same protocol.

The "Deploy to Cloudflare" button isolates `worker/` into a fresh repo, so the Worker cannot import above its own directory. Its shared closure is `WORKER_SHARED_MODULES` in `scripts/hub-build-manifest.js`; `npm run sync:worker` vendors it into `worker/src/shared/`, mirroring each module's directory so relative requires resolve in both trees. The copies are `@generated` and CI fails on drift: edit `src/shared/`, then sync. Modules in the closure cannot use Node built-ins.

## Generated and registered state

Remote Hub update checks compare `src/shared/hubBuildRegistry.json`, not the product version. It hashes the portable Hub core plus separate Node and Worker adapters, so a desktop-only release does not ask users to redeploy. The marker is a registered build identity, not attestation: describe divergent metadata as unrecognized rather than claiming every fork is detectable. Run `npm run update:hub-build` once the Hub/shared change is final; the Hub-build test fails when it is stale. Never hand-edit generated Worker metadata.

Only the app, agent and packaging scripts run `ensure:tokscale`, which installs the pinned binary from `scripts/vendor/tokscale.json`; install, hub, lint, test and verify never download it. The manifest's `mode` (`override`/`upstream`) gates binary provenance only — both `verify-vendored-tokscale*.js` gates run against whichever binary is authoritative.

## Collector pipeline

`src/shared/collector.js` owns every tokscale scan and the binary resolution behind it; self-sync spawns take its resolver rather than repeating it.

- **Serial full scans, exact watch deltas.** Full ticks run today / month / allTime serially, because concurrent scans triple peak CPU/IO. Watch ticks scan `--today` only and derive month/allTime through `applyPeriodDelta()` anchored to the last full scan. The delta is an identity for append-only logs, not an estimate; a stale-date anchor forces a full scan.
- **Workspace grouping with a per-binary fallback.** The vendored fork's `client,workspace,session,model` grouping returns session and workspace metadata, folded in by `applyTokscaleSessionMetadata()`. A binary that rejects it falls back to `client,session,model`, cached per binary identity. Local metadata resolvers stay enabled either way and skip per session, not per tick, because one scan attributes some clients and not others.
- **Project identity is ours.** Only a decoded path counts, hashed by `projectIdentity()`; an opaque workspace key is left for the resolvers, since hashing it would mint a second identity for a directory other clients name correctly.
- **Defensive extraction.** `src/shared/usage.js` deep-walks tokscale's JSON and never assumes a fixed layout.
- **Targeted watch scans.** Changed paths map back to clients, and those partitions are scanned in one unioned `--today` scan. That makes the client id a partition key — see the partition invariants in `docs/providers/README.md`.

### Watching

- There is no cooldown on top of the debounce, because the product promises 3–5 s updates.
- The self-synced tokscale cache dirs (cursor, antigravity) are not watched: only our own syncs write them, so watching them re-triggers forever. Antigravity's source roots are watched, because tokscale only reads them.
- `resolveWatchUsePolling()` owns the native-vs-polling default (`TOKEN_MONITOR_WATCH_POLLING` overrides it). Descriptor exhaustion (`ENOSPC`/`EMFILE`/`ENFILE`) rebuilds the watcher on polling, sticky for the process.
- The watcher runs in a worker thread (`src/shared/watcherHost.js`), because chokidar's synchronous `close()` froze the widget on every root change. Roots, attribution, debouncing and tick decisions stay on the owning thread. Do not replace worker recycling with `unwatch()`: it keeps the descriptors. Watch-behaviour tests pin the in-process host with `TOKEN_MONITOR_WATCH_IN_PROCESS` via `tests/helpers/watchHost.js`.

### Self-sync

`src/shared/selfSyncThrottle.js` rations the cursor/antigravity syncs, which live in `providers/<id>/selfSync.js`. The collector hands its one throttle to both; a provider-local throttle would outlive the collector rebuild it must follow. `forceSelfSync`, `sourceSelfSync` and `todayOnly` are independent selections — forcing a sync never downgrades a full scan. A collector replacement cancels an in-flight sync rather than recording it as a failure. Keep the floor and the catch-up deadline as single functions: every divergence between copies has been a bug.

### WSL

On Windows, `src/shared/wslUsage.js` also scans **running** WSL distros. It gates on the `HKCU\…\Lxss` registry key so `wsl.exe` is never spawned without WSL (the inbox stub shows an install prompt), never starts a stopped distro, and scans serially. The result merges into the Windows periods before `deriveClientStatus`, so a WSL-only client still shows active. It refreshes on full ticks only and is frozen between them (`wslAnchor`), which keeps the Windows delta anchor exact; the watcher is not extended to WSL.

### Subprocess lifecycle

`SIGTERM` only requests termination. Aborts, timeouts and pipe failures stay pending until the child emits `close`, so a replacement tick waits behind the old runtime; an ignored request escalates to `SIGKILL`. If even that never reports `close`, a bounded grace emits `subprocess-termination-unconfirmed` and releases the barrier rather than deadlocking usage; the generation fence still rejects late output.

A failed usage reconfiguration rolls back to the last-known-good runtime and retries the latest desired settings on a bounded backoff, emitting `usage-reconfigure-exhausted` when the budget runs out. A newer setting starts a fresh budget.

## Limits collector

`src/shared/deviceRuntime.js` runs usage and limits independently: `UsageRuntime` owns the tokscale collector, `LimitsRuntime` owns refresh timing, bounded concurrency, per-provider latest-wins lanes, deadlines, retry/backoff and `lastGood`/`lastAttempt` retention. A credential change refreshes only its limits lane and never restarts usage, unless a provider note says otherwise (Cursor forces one targeted usage sync).

- `limitsRefreshMode` (`fixed`/`adaptive`) is separate from `limitsRefreshMs`, so fixed intervals keep their meaning and nothing doing arithmetic on the interval handles a sentinel. The adaptive control law is in `limits/burnRate.js`; why `burn-rate` bypasses no cooldown and why local token usage never triggers a refresh is commented in `limits/runtime.js`.
- Dispatch starts in `src/shared/limits/collector.js`; its fetchers come from the static registry in `limits/registry.js`. Each provider's require-free `account.js` declares credential and account metadata; `src/electron/limits/accountSettings.js` binds main-process normalization and renderer redaction without introducing a dependency from `credentialStore.js` back into provider probes. The renderer receives only a serializable form DTO; raw credentials stay in main and save through `settings:update`. Forms requiring a live credential check use `limits:validateCredential`: main admits only registry entries that declare validation, probes their declared field with the injected transport, and never persists a failed credential. Normalization of quota results lives in `src/shared/limits/core.js`. There is no `limits/index.js` because the Worker imports `core.js` as ESM, which does not resolve directories. `limitProviders.js` and `limitBalanceDisplay.js` stay top-level because the renderer loads them by `<script src>`.

### Outbound transport

`src/electron/limitsFetch.js` chooses the transport at the runtime boundary: `src/shared/outboundFetch.js` when a proxy env is set, Electron's `net.fetch` otherwise, so the OS proxy applies without setup. The collector and the account-settings probes both take it.

- `probeLimitProvider` injects a resolved `fetch` and `createOutboundFetch` returns an injected one untouched, so a provider's own env-proxy call is dead unless its lane builds its own deps. A probe with its own transport (`node:https`, `claudeWebFetch`, a spawned CLI) inherits none of this and its note must say so.
- Chromium is not undici: never send a `Host` header (the request is rejected), keep `credentials: 'omit'` so the session cookie jar cannot shadow a provider-managed `Cookie`, and expect a cross-origin `Referer` with a path to be cancelled unless the provider sets a looser `referrerPolicy`.

### Balance quotas

`windows[].metric === 'credits'` marks a money quota (`remaining` + `currency`). `src/shared/limitBalanceDisplay.js` is the single display entry point for Home, the tray and the limits page: key off the marker, never a provider whitelist. The top-up meter percentage is a display derivation and stays out of the wire shape.

## Widget mode switching

`settings.hubMode` selects the data path. `local` runs the local collector over IPC. `client` stops it, opens the Hub SSE stream and runs a sync collector for this device. `host` adds an embedded Hub (`startEmbeddedHub()`). A widget sync collector skips posting while the PID in `data/agent.pid` is alive — the only coordination between widget and headless agent.

## Settings and credentials

- **`.env`** at the project root is loaded by `loadDotEnv()` without overriding existing process variables. Node entry points always load it; the Electron widget only when unpackaged; the Worker never (it uses deployment bindings). `.env.example` is the documented operator surface — keep it aligned, and treat additions or removals as compatibility changes.
- **Precedence** for agent and standalone Hub options with a CLI flag is `CLI flag → env (real or .env) → built-in default`; env-only settings have no CLI layer. There is no JSON config file.
- **Widget storage** splits by sensitivity: `userData/settings.json` holds preferences and account metadata, `userData/credentials.json` holds raw GUI-managed credentials. The credential store is deliberately plaintext with POSIX `0600` (Windows relies on the `userData` ACL) rather than Keychain, to avoid OS prompts; it does not protect against processes running as the same user. The agent and standalone Hub never read it.
- **Renderer redaction** is default-deny: raw credentials reach the renderer only through an explicit allowlist (currently the two Hub secrets the sync UI needs).
- **New credentials** are declared as a field `storePath` in the provider's `src/shared/providers/<id>/account.js`; `CREDENTIAL_SETTING_PATHS` derives from those declarations, so a literal entry added to `credentialStore.js` would bypass the refresh-scope keys and renderer projection. Dynamic accounts use a nested path in the same store — never a provider-specific store.
- **Migration** writes and verifies the new store before stripping the old source. Corrupt, unknown-version or symlinked stores are never replaced with an empty document.

## Data flow contract

The Hub stores normalized device records (`normalizeDeviceRecord`) and aggregates on read (`aggregateDevices`). `DeviceState` composes the wire record from usage, the runtime envelope and limits: limits-only updates keep the usage `updatedAt`, and cold-start previews wait for a complete usage baseline. `collectUsageOnce()` owns the usage portion; `docs/API.md` documents the full contract, which the Worker shares exactly. Neither Hub needs provider credentials.

Settings keys, env vars, CLI flags, Hub endpoints and this wire shape have external users: treat changes as breaking and plan the migration.

A device older than `staleAfterMs` (default 10 min) stays in `/api/stats` with `stale: true` and is greyed out — intentional, not a bug.

## Subscriptions are hub-scoped

Manually recorded subscriptions (`src/shared/subscriptionDisplay.js`) are the one Hub document that is not per device. `accountKey` differs across platforms for the same login, so per-device copies could not be deduped and two machines would double the monthly total. `GET`/`PUT /api/subscriptions` read and write one list per Hub.

- `PUT` carries `baseUpdatedAt` and gets `409` on mismatch, because this data exists nowhere else. The token is the version the renderer's edit was made on, never re-derived at write time; a write queued behind a refresh that pulled other devices' records is refused, not retargeted.
- In `client`/`host` mode the local copy is only a cache, and writes while the Hub is unreachable are refused rather than forking the list.
- Propagation is by the `subscriptionsUpdatedAt` stamp on every stats frame; there is no periodic subscription read. A device re-reads only when the stamp disagrees, compared inside the subscription lane, and retries a failed catch-up for the same version at most once a minute. A missing stamp means no news.
- The stamp is added by `statsWithSubscriptionVersion()` on authenticated paths only. The Worker's unauthenticated `/api/public/stats` spreads `getStats()`, so folding the stamp into `getStats()` would publish it there.
