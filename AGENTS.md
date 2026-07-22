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

### Collector pipeline (shared by widget and agent)

`src/shared/collector.js` is the only place that invokes `tokscale`. It:
1. resolves the platform binary from `@tokscale/cli-<platform>-<arch>` and falls back to the JS shim under Electron via `ELECTRON_RUN_AS_NODE=1`;
2. runs three `tokscale --json --client <csv> --group-by client,model` calls (today / month / since `allTimeSince`) on full ticks (startup / interval / manual) — serially on purpose: concurrent scans triple peak CPU/IO. Watch-triggered ticks instead scan only `--today` and derive month/allTime **exactly** via `applyPeriodDelta()` anchored to the last full scan (every tokscale period scan costs the same full-load+filter, so the win is 3 spawns→1; the delta is an identity for append-only logs, NOT an estimate; stale-date anchors force a full scan);
3. funnels output through `extractUsageFromTokscale()` in `src/shared/usage.js`, which is a defensive deep-walker over tokscale's JSON shape (it never assumes a fixed layout — that's why `tokenValue`/`detectClient` accept many key spellings);
4. watches the per-client data directories from `watchPathsForClients()` with chokidar (`usePolling: true, interval: 2000`) and debounces refreshes by `watchDebounceMs` (no cooldown — the product promises 3–5 s updates; mid-tick watch events re-arm the debounce timer instead of coalescing). The cursor/antigravity tokscale cache dirs are deliberately *not* watched — only our own `maybeSync*` calls write them, so watching them re-triggers forever — and those syncs are gated + throttled (`SYNC_MIN_INTERVAL_MS`).
5. on Windows, also scans usage from **running** WSL distros (`src/shared/wslUsage.js`). It registry-gates on `HKCU\…\Lxss` (so `wsl.exe` is never spawned without WSL — the inbox stub otherwise shows an interactive install prompt), lists running distros via `wsl.exe --list --running` (never auto-starts a stopped one), keeps homes containing tracked-client data, and runs `tokscale --home \\wsl$\<distro>\home\<user>` per home (serial, same CPU/IO reason as above). The bundle is merged into the Windows periods in `collectUsageOnce` **before** `deriveClientStatus` (so a WSL-only client still shows active); `mergePeriods`/`addPeriodInto` (in `usage.js`) do the additive sum. It refreshes on full ticks only and is frozen between them (`wslAnchor` in `startCollector`), so the Windows-only delta anchor stays exact and the chokidar watcher is **not** extended to WSL. Non-`win32` is a no-op. Default on, no setting.

### AI Tool Limits collector

Usage and limits have independent lifecycles under `src/shared/deviceRuntime.js`: `UsageRuntime` owns the tokscale collector, while `LimitsRuntime` owns its refresh timer, per-provider latest-wins lanes, scoped account refreshes, finite probe deadlines, and `lastGood` / `lastAttempt` retention. Credential changes refresh or clear only the affected limits lane and never restart usage; Cursor additionally forces one targeted usage sync because its tokscale cache is self-synced.

`DeviceState` composes both outputs into the unchanged device wire record, buffering limits until usage exists and cold-start previews until a complete usage baseline exists; limits-only updates preserve the usage `updatedAt`. Provider dispatch starts in `src/shared/limitCollector.js`, with provider-specific implementations split between that file and `src/shared/*Limits.js`; shared normalization remains in `src/shared/limits.js`. The hub and Worker receive the composed record and never need provider credentials.

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
| Watch paths | the `add(...)` call in `clientWatchCandidates()` (`src/shared/collector.js`) |
| Name normalization | the `normalizeClientName()` branch in `src/shared/usage.js` |
| Renderer maps | `clientLabels` / `clientsWithIcon` / `KNOWN_CLIENTS` in `src/electron/renderer/app.js`; `VENDOR_ORDER` / `VENDOR_LABELS` in `themePresets.js`; `clientColors` in `usageCharts.js` |
| Discord RPC | `KNOWN_CLIENT_ASSETS` / `CLIENT_LABELS` in `src/electron/discordRpc.js` |
| Row icon CSS | the `.row-icon-<id>` rule in `src/electron/renderer/styles.css` |
| Icon assets | `assets/icons/<id>.svg` + `.github/assets/tools-icon/<id>.png` |
| WSL discovery | marker(s) in `WSL_DATA_MARKERS` **and** the marker→id mapping in `MARKER_CLIENTS` (`src/shared/wslUsage.js`) — use the exact roots tokscale reads, including alternate roots. A marker without a `MARKER_CLIENTS` entry attributes to nothing, so a WSL home holding only that client's data would be skipped |
| Docs & env examples | the supported-tools table in `README.md` and its translations (`README.*.md`) + the client CSV in `.env.example` |
| Guard tests | the expected-client lists in `tests/shared/clientTracking.test.js` |

Two caveats on top of the table:

- If the client's tokscale `--home` scan can fall back to a HOST-native DB that ignores `--home` (currently only `zed`), also add it to `WSL_HOST_FALLBACK_GATES` keyed to the WSL-home file whose presence suppresses that fallback, so it is dropped from a home's scan when absent and never double-counts the host DB.
- Self-synced clients (cursor/antigravity) additionally go in `SELF_SYNCED_CLIENTS`; parse-local clients must NOT.

### Data flow contract

The hub stores normalized device records (`normalizeDeviceRecord` in `usage.js`) and aggregates on read (`aggregateDevices`). The wire shape between agent/widget and hub is whatever `collectUsageOnce()` returns — that function is the source of truth, and `docs/API.md` documents the full contract. The core is `{deviceId, hostname, platform, updatedAt, agentVersion, today, month, allTime}` (each period has `{totalTokens, costUsd, clients, clientCosts, models, modelCosts}`), plus attribution fields (`trackedClients`, `clientStatus`, `wslStatus`, `periodWindows`, `projectsEnabled`) and optional `osName` / `osVersion` / `agentRuntime` / `history` / `limits`. The Worker hub uses the exact same shapes.

### Stale devices

A device is "stale" if `Date.now() - receivedAt > staleAfterMs` (default 10 min). Stale devices still appear in `/api/stats` with `stale: true`, and the renderer greys them out — this is intentional, not a bug.

## Conventions

- **Consider best practices first.** When picking an approach — library vs hand-roll, pattern vs custom, framework default vs override — start by checking the ecosystem convention, not by optimizing for "fewer deps" or "less code". If a hand-rolled solution is genuinely better, argue that *after* weighing the convention.
- **This project has external users.** Settings keys, env vars, CLI flags, hub endpoints, and the wire shape (`docs/API.md`) are compatibility surfaces — treat changes to them as breaking and think about migration. Internal code can still be refactored and renamed freely.
- **Don't add dependencies or new tooling without discussing it first** (in the issue or PR description).
- **Keep this file lean and current.** Document non-obvious constraints and gotchas, not descriptions the code already makes obvious. Avoid hardcoded counts and exhaustive lists (prefer a command like `ls src/shared/` over a hand-maintained one); verify claims against the code before writing them; delete anything that has gone stale — an outdated note is worse than none.

### Commit messages

Format: `<type>(<scope>): <subject>` — conventional-commit types (`feat` / `fix` / `refactor` / `docs` / `chore` / `perf` / `test` / …), with a scope when the change targets a clear subsystem (`fix(hermes):`, `fix(collector):`, `feat(limits):`); leave it off for cross-cutting or general changes. Aim for a subject ≤ ~72 chars that describes the actual change. Add a **body** only when the diff doesn't make the *why* obvious — rationale, rejected alternatives, behaviour-preserving notes, linked issues; trivial changes stay single-line. Write body paragraphs as continuous lines, not hard-wrapped.

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
