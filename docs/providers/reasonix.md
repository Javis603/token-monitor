---
summary: "Reasonix provider notes: Tokscale aggregate authority, local-only native sessions, bounded sidecar replay and privacy guards."
ids: [reasonix]
read_when:
  - Changing Reasonix source paths, tokscale normalization or watcher roots
  - Changing Reasonix native session/project views or Session Detail replay
  - Changing serialization, sync, history or synthetic-session filtering for Reasonix
---

# Reasonix

Reasonix deliberately has two views with different authorities:

- tokscale owns aggregate token, model and cost totals;
- Token Monitor's native adapter owns richer local session/project presentation.

Never add native values into aggregate periods. That would double count the same activity.

## Paths and portability

The state root resolves `REASONIX_STATE_HOME`, then `REASONIX_HOME`, then the platform default. Environment references, home shorthand, relative paths and separators follow Reasonix's own cleaning semantics. `paths.js` stays free of Node built-ins because the source check and resolver enter the Worker shared closure even though filesystem reading remains local.

Reasonix is not scanned through WSL discovery. Its native state and watcher roots are host-local.

## Aggregate versus native sessions

`stats/*.jsonl` remains tokscale's aggregate authority. Sidecar telemetry and official event logs produce `native: true` rows for local UI only. Native rows may expose titles, projects, current messages and cumulative official telemetry without claiming period totals the source cannot prove.

Native sessions never enter ordinary `period.sessions`, history, archive or sync payloads. `sessionGuard.js` removes every Reasonix-shaped ordinary session fail-closed, including legacy stats-path ids that could leak a local path. Hub/device normalization must preserve that guard.

Cumulative telemetry is reliable only where the adapter can attribute it. A metadata rename or update must not move an old session into today. `allTimeSince` excludes a session conservatively when its trustworthy creation boundary predates the configured start. Native project totals omit unavailable or period-ambiguous token data.

## Bounded file handling

Metadata reads are regular-file and size bounded. A large telemetry sidecar is projected from its final `usage` field without materializing the preceding `ReadFiles` array. Candidate failures are negative-cached only while their fingerprints remain unchanged; root and sidecar discovery must recover when files appear, change or are deleted.

Official event replay accepts only supported schemas and event transitions. It keeps the last trusted state across a torn tail, but fails closed on unsupported schemas, illegal appends, unknown event types or resource-limit breaches. Legacy typed events remain compatibility input, not authority for new schema behavior.

Session Detail uses the same bounded replay and positive allowlist as compact rows. Missing/corrupt identity, telemetry or transcript files produce no detail rather than a partially trusted reconstruction.

## Verification

Run the Reasonix path, aggregate, native-session and replay tests when changing this note's scope:

```bash
node --test tests/shared/reasonix*.test.js
```
