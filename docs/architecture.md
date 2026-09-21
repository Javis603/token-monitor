---
summary: "Cross-runtime architecture contracts for collection, limits, Hub/Worker portability, configuration and credentials."
read_when:
  - Changing boundaries shared by the widget, agent, Hub or Worker
  - Changing collector scheduling, limits scheduling or the device wire record
  - Changing shared configuration, credential storage or renderer redaction
---

# Architecture

This document records cross-runtime constraints that are easy to violate from one subsystem. Provider-specific behavior belongs in `docs/providers/`.

## Runtime and wire boundaries

`src/electron/main.js`, `src/agent/agent.js` and `src/hub/server.js` share `src/shared/`; `worker/src/index.js` implements the same Hub protocol from an isolated deployment tree.

- Widget `local` mode runs the local collector. `client` consumes Hub SSE and posts this device through a sync collector. `host` adds the embedded Hub.
- A widget sync collector yields to a live headless-agent PID. That PID file is their only coordination.
- `DeviceState` composes independent usage and limits runtimes into the device record. Limits-only updates preserve usage `updatedAt`; cold-start previews wait for a complete usage baseline.
- `collectUsageOnce()` is the source of truth for the device shape. Node Hub and Worker normalize and aggregate that same shape; provider credentials and collector-only state never enter it.
- Public compatibility surfaces include settings keys, environment variables, CLI flags, Hub endpoints and the device wire shape. Plan migrations before changing them.

Manually recorded subscriptions are Hub-scoped account data, not device data. Remote writes use versioned conflict detection and must not fork state when the Hub is unavailable. Keep private subscription stamps out of unauthenticated public stats.

## Usage collection

`src/shared/collector.js` owns tokscale resolution and every usage scan for the widget and agent.

- Full ticks scan today, month and all time serially. Watch ticks scan today and apply an exact delta to fresh full-scan anchors; stale-date anchors force a full scan.
- Prefer workspace/session/model grouping, but retain the cached fallback for binaries without workspace grouping. Local metadata resolvers remain per session because one scan can attribute some clients but not others.
- Project identity comes from a decoded path, never an opaque workspace key. `src/shared/usage.js` owns defensive extraction and normalization.
- Targeted watch scans depend on canonical ids normalizing to themselves, aliases filtering back to their parent and filters never emitting `synthetic`. The partition-invariant tests guard this contract.
- Generated self-sync caches are not watch roots. Provider-native source roots may be watched when tokscale only reads them. Self-syncs share the collector's resolver and throttle; collector replacement cancels their in-flight attempt without recording a provider failure.
- Watcher exhaustion falls back to process-sticky polling. The watcher normally lives in a worker thread; roots, attribution, debounce and tick selection remain on the owning thread.
- Windows scans running WSL distros on full ticks only, never starts a stopped distro and freezes the WSL result between full scans.
- Subprocess termination is not complete until `close`. Abort and timeout paths escalate after the shared grace period and fence late output; an unconfirmed forced termination eventually releases the logical barrier instead of deadlocking collection.

## Limits collection

`LimitsRuntime` owns refresh scheduling, bounded cross-provider concurrency, per-provider latest-wins lanes, deadlines, retry/backoff and last-good retention. Credential changes refresh only their provider lane unless a provider note names a usage-side sync requirement.

- Provider dispatch starts in `src/shared/limits/collector.js`; shared normalization belongs in `src/shared/limits/core.js`.
- Fixed and adaptive refresh mode remain separate settings. Local token usage is not a subscription-quota trigger, and rate limiting uses the existing backoff rather than a second circuit breaker.
- Transport is selected at the runtime boundary and injected into collection and account probes. A provider using a custom transport does not inherit shared proxy or Electron-fetch behavior and must document that exception.
- Electron fetch must not receive a manual `Host` header and must use `credentials: 'omit'` for provider-managed cookies.
- Balance quotas use `windows[].metric === 'credits'`. Formatting and display-only percentage derivation belong in `src/shared/limitBalanceDisplay.js`, not provider wire data.

## Configuration and credentials

Every entry point loads the project `.env` without overriding an existing process variable. Widget settings merge persisted GUI values over env-seeded defaults; agent and standalone Hub use `CLI flag -> process env or .env -> built-in default` and never read widget credential storage.

- `.env.example` is the supported operator-facing env surface.
- Widget preferences and account metadata live in `settings.json`; raw GUI-managed credentials live in the permission-restricted shared credential store.
- Fixed credential fields register in `CREDENTIAL_SETTING_PATHS`. Dynamic account credentials use a nested path in the same store rather than a provider-specific secret store.
- Renderer settings are default-deny. Raw credentials cross into the renderer only through an explicit allowlist.
- Legacy migration writes and verifies the new store before stripping the old source. Corrupt, unknown-version or symlinked stores must not be replaced with an empty document.

## Worker and generated state

The Worker cannot import above `worker/`. `WORKER_SHARED_MODULES` declares the portable closure and `npm run sync:worker` mirrors it under `worker/src/shared/`; edit source files, never generated copies. Shared modules in that closure cannot depend on Node-only built-ins.

Remote Hub update checks use `src/shared/hubBuildRegistry.json`, not the product version. Run `npm run update:hub-build` once after the final Hub/shared implementation is stable and do not hand-edit generated Worker metadata.

The tokscale manifest controls binary provenance. App, agent and packaging entry points may ensure the binary; install, Hub, lint, test and verify must not download it.
