---
summary: "Reasonix provider notes: Tokscale aggregate-only authority, path resolution, normalization rules and synthetic-session privacy guards."
ids: [reasonix]
read_when:
  - Changing Reasonix source paths, tokscale normalization or watcher roots
  - Changing serialization, sync, history or synthetic-session filtering for Reasonix
---

# Reasonix

## Identity and ids

`reasonix` is an aggregate-only tracked client (there is no Reasonix limits provider). Reasonix upstream stopped maintenance on 2026-11-12 (archived; final release v2.61.0), so Token Monitor carries only Tokscale aggregate tracking and no separate native session/detail adapter.

## Data sources

Tokscale `stats/*.jsonl` is the sole authority for Reasonix token, model and cost totals across Today, Month, Total, History/Trends and Hub sync. Native Sessions, Projects and Session Detail are deliberately unsupported.

## Paths and portability

The state root resolves `REASONIX_STATE_HOME`, then `REASONIX_HOME`, then the platform default (`%APPDATA%\reasonix` on Windows, `~/.reasonix` elsewhere), appending `stats` for `resolveReasonixStatsDir()`. Environment references, home shorthand, relative paths and separators follow Reasonix's own cleaning semantics. `paths.js` stays free of Node built-ins because the `reasonix-stats` source check id and resolver enter the Worker shared closure even though filesystem reading remains local.

Reasonix is excluded from WSL discovery (`WSL_EXCLUDED_CLIENTS`): Tokscale's Windows `PathRoot::ReasonixHome` conflicts with Linux-default `.reasonix/stats` paths inside WSL.

## Invariants and privacy guards

- **Disjoint reasoning and request counts.** Reasonix folds `reasoning` into the public `outputTokens` bucket (`TOKSCALE_DISJOINT_REASONING_CLIENTS`), while History zeroes `messages` for Reasonix because Tokscale's counter reflects provider requests rather than user turns.
- **Scoped model normalization.** `normalizeModelNameForClient()` strips `deepseek/` and `deepseek-flash/` prefixes only when given explicit `reasonix` client context.
- **Fail-closed session guard.** Reasonix does not emit ordinary `period.sessions`, archive, history or sync entries. `sessionGuard.js` (`isReasonixSyntheticSession` / `filterReasonixSyntheticSessions`) removes every Reasonix-shaped ordinary session fail-closed — including legacy `reasonix-stats:` path IDs that could leak a local path — across usage normalization, delta application, session usage archives, anchor seeding, local session merging, sync payloads, renderer `sessionRows.js`, and Hub/Worker ingestion. `sessionRows.js` also drops any stale Reasonix entries in `nativeSessions` and strips `reasonix-stats:` prefixes in `sessionIdLabel()`.

## Verification

Run the Reasonix path, aggregate and synthetic-session guard tests when changing this note's scope:

```bash
node --test tests/shared/reasonix*.test.js
```
