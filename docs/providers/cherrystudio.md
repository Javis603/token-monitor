---
summary: "Cherry Studio chat ledger and Agent transcript sources, watch boundaries, token accounting and parser limitations."
ids: [cherrystudio]
read_when:
  - Changing Cherry Studio source discovery, health checks or file watching
  - Changing Cherry Studio usage normalization or vendored parser contracts
---

# Cherry Studio

## Identity and ids

`cherrystudio` is the tracked-client id for Cherry Studio usage. Native DSH and Pi sessions configured through those clients' custom scan paths remain attributed to DSH and Pi.

## Data sources

Tokscale reads built-in chat usage from the exact `Data/cherrystudio.sqlite` invocation ledger beside Cherry Studio's Agent transcript roots. Agent usage also comes from Claude Code transcripts under the separate `.claude/projects` roots.

Source health probes the database file itself. An attachments-only `Data` directory does not claim chat usage is available.

## Invariants and known gaps

- Bound the `Data` watch to `cherrystudio.sqlite`, `cherrystudio.sqlite-wal` and `cherrystudio.sqlite-shm` directly under that directory. Keep Agent transcripts recursive through their separate roots so pruning unrelated application data does not hide transcript updates.
- Cherry Studio's read-only SQLite scans rewrite the SHM wal-index. Its events are filtered before scheduling collection, while database and WAL changes still trigger usage refreshes.
- The ledger emits disjoint reasoning tokens. Usage and history fold those tokens into the public output bucket and include them once in token totals.
- Tokscale excludes `agent-session` and legacy aggregate rows from the ledger to avoid counting transcript calls twice. Legacy-aggregate-only migration history is not included.
- The pinned parser does not read `total_tokens`. Total-only invocations without a positive authoritative USD cost are omitted; a positive authoritative USD cost preserves the invocation, but its token count remains zero.

## Verification

```bash
node --test tests/docs/providerGuidance.test.js tests/shared/cherryStudio.test.js tests/shared/collectorLoadGuards.test.js
node scripts/verify-vendored-tokscale.js
```

The tests cover source health, bounded database watching alongside recursive Agent roots, SHM suppression without suppressing DB/WAL scans, and reasoning totals. The binary contract checks modern chat ledger parsing and exclusion of overlapping Agent and legacy aggregate rows. These fixtures do not establish coverage of every Cherry Studio agent/export format.
