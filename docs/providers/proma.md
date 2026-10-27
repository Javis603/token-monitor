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

Before upstream supported Proma, Token Monitor's tokscale fork read only `agent-sessions/*.jsonl` and keyed each journal as `<file stem>@<namespace>`, the namespace being the first 6 bytes of sha256 over the normalized journal root. Upstream keys the same usage by SDK or native Pi session ids, which cannot be derived from the stem, so the session archive would replay fork rows beside their upstream copies. On each completed full scan the collector therefore lists the fork keys of journals that still exist in every home (host or WSL) whose scan reported Proma usage (`legacyPromaSessionKeys`, a private summary hint stripped before sync), and the archive records those rows as an explicit zero. A home that reported no Proma usage proves nothing: a binary without upstream Proma, including the stock npm 4.20.1 build, drops the id through capability filtering and still exits successfully. The ids cannot prove that a particular journal was reported, so within a reporting home a journal's own usage is whatever the upstream reader reports for it, as for any rescanned source. A fork row whose journal is gone keeps replaying as the only record. If a user deletes a display journal but keeps its native session, that fork row and the native usage can still both count.

Custom scan paths stay unsupported for Proma; upstream accepts extra roots, but offering them is a separate feature.

## Verification

`node --test tests/shared/legacyPromaSessions.test.js tests/shared/clientHealth.test.js tests/shared/clientRegistrationConsistency.test.js`
