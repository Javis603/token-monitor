---
summary: "Proma Agent usage: upstream tokscale's native reader, and the archive rows the fork reader left behind."
ids: [proma]
read_when:
  - Changing Proma source detection or watch behavior
  - Debugging missing, doubled or stale Proma usage, especially after upgrading from a fork-era build
---

# Proma

## Data sources

Upstream tokscale (`sessions/proma.rs`, documented in its `docs/proma.md`) reads the Agent display journals in `agent-sessions/*.jsonl` and the native Pi and legacy SDK transcripts in `sdk-config/sessions/` and `sdk-config/projects/`, under both `~/.proma` and `~/.proma-dev` of the effective tokscale home. Those six directories are the watch roots and WSL markers. The optional `~/.proma/agent-sessions.json` index only links display journals to native sessions; watching it would mean watching the whole Proma home with its config and credentials, so index-only edits wait for the periodic full tick.

## Invariants and known gaps

Before upstream supported Proma, Token Monitor's tokscale fork read only `agent-sessions/*.jsonl` and keyed each journal as `<file stem>@<12 hex namespace>`. Upstream reports the same usage under Proma, SDK or Pi session ids, after deduplicating across journals and native transcripts. The session archive keeps only per-session aggregates, so a fork-era row cannot be matched to the upstream rows that now cover it: replaying it would count rescanned journals twice, and retiring it by inference can erase usage only the fork read.

Fork-era rows (`isForkEraPromaSession` in `src/shared/providers/proma/sessionGuard.js`: client `proma` and a session id of the form `<no @>@<12 lowercase hex>`; Proma names journals after `randomUUID()` ids) therefore stay in the session archive unchanged but are not replayed into Today, Month or All time. Totals count what upstream reports now, and its rows are archived under their upstream ids, so they are retained after their sources are deleted. Usage that only a fork-era row held, such as a journal deleted before the upgrade or records upstream does not read, is not part of the totals any more. This is a deliberate scope, not a lossless migration. Daily trends keep the per-day maximum the history archive already retained for each client and model, so days where the fork counted more can still show the fork value there.

Custom scan paths stay unsupported for Proma; upstream accepts extra roots, but offering them is a separate feature.

## Verification

`node --test tests/shared/promaForkArchive.test.js tests/shared/clientHealth.test.js tests/shared/clientRegistrationConsistency.test.js`

`tests/fixtures/proma-fork-upgrade.json` holds report entries from the released fork build and the upstream reader over the same Proma homes.
