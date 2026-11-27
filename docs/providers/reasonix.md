---
summary: "Reasonix provider notes: Tokscale aggregate authority, on-demand local session browsing, and privacy guards."
ids: [reasonix]
read_when:
  - Changing Reasonix source paths, tokscale normalization or watcher roots
  - Changing local Reasonix Sessions or Session Detail
  - Changing serialization, sync, history or synthetic-session filtering for Reasonix
---

# Reasonix

## Identity and ids

`reasonix` is a tracked client with no limits provider. Reasonix upstream stopped maintenance on 2026-11-12 (archived; final release v2.61.0).

## Data sources

Tokscale `stats/*.jsonl` is the sole authority for Reasonix token, model and cost totals across Today, Month, Total, History/Trends and Hub sync. Open Sessions to read local session metadata, telemetry, and bounded events for Today, Month, or Total. Reopen Sessions or use Refresh to read the files again. Selecting a session with a readable transcript opens Session Detail. Per-turn data is shown only where the transcript supplies it. Cumulative telemetry is never allocated to individual turns.

Native session files are outside the collector and watcher loop. Their rows are local to the Sessions view and do not enter Projects, the tray, or device records. Sessions routed under `projects/*/sessions/` remain readable.

## Paths and portability

The state root resolves `REASONIX_STATE_HOME`, then `REASONIX_HOME`, then the platform default (`%APPDATA%\reasonix` on Windows, `~/.reasonix` elsewhere), appending `stats` for `resolveReasonixStatsDir()`. Environment references, home shorthand, relative paths and separators follow Reasonix's own cleaning semantics. `paths.js` stays free of Node built-ins because the `reasonix-stats` source check id and resolver enter the Worker shared closure even though filesystem reading remains local.

Reasonix is excluded from WSL discovery (`WSL_EXCLUDED_CLIENTS`): Tokscale's Windows `PathRoot::ReasonixHome` conflicts with Linux-default `.reasonix/stats` paths inside WSL.

## Invariants and privacy guards

- **Disjoint reasoning and request counts.** Reasonix folds `reasoning` into the public `outputTokens` bucket (`TOKSCALE_DISJOINT_REASONING_CLIENTS`), while History zeroes `messages` for Reasonix because Tokscale's counter reflects provider requests rather than user turns.
- **Scoped model normalization.** `normalizeModelNameForClient()` strips `deepseek/` and `deepseek-flash/` prefixes only when given explicit `reasonix` client context.
- **Fail-closed session guard.** Reasonix session rows never enter ordinary `period.sessions`, archives, History, or sync. `sessionGuard.js` (`isReasonixSyntheticSession` / `filterReasonixSyntheticSessions`) removes every Reasonix-shaped ordinary session fail-closed — including legacy `reasonix-stats:` path IDs that could leak a local path — across usage normalization, delta application, session usage archives, anchor seeding, local session merging, sync payloads, renderer `sessionRows.js`, and Hub/Worker ingestion. `sessionRows.js` also drops any stale Reasonix entries in `nativeSessions` and strips `reasonix-stats:` prefixes in `sessionIdLabel()`.

## Verification

Run the Reasonix path, aggregate and synthetic-session guard tests when changing this note's scope:

```bash
node --test tests/shared/reasonix*.test.js
```
