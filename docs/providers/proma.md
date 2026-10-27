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

Before upstream supported Proma, Token Monitor's tokscale fork read only `agent-sessions/*.jsonl` and keyed each journal as `<file stem>@<namespace>`, the namespace being the first 6 bytes of sha256 over the normalized journal root. Upstream keys the same usage by the records' own session ids (else the stem), a Pi header id, or the native session its index entry links through `sdkSessionId`, so the session archive would replay fork rows beside their upstream copies.

A completed full scan therefore passes the journal roots it read (`legacyPromaRoots`, host plus successfully scanned WSL homes; a private summary hint stripped before sync). For each fork row with usage under one of those roots, the archive derives the session ids its journal can be reported under, mirroring upstream's reader, and records an explicit zero only when the scan's All time reports one of them. Retirement is per journal, never per home: a journal that is gone, unreadable, without usage records, or whose ids the scan did not report keeps its fork usage, so a scan that misses a journal (including a binary without upstream Proma, which drops the id through capability filtering) cannot erase history. A period stored after the capture is left alone, and a fork id the scan still reports stays live. Usage the index hands to a native session only through `piSessionFile` is not matched, because Token Monitor does not open paths stored in the index; such a journal keeps its fork row and can count beside the native usage.

Custom scan paths stay unsupported for Proma; upstream accepts extra roots, but offering them is a separate feature.

## Verification

`node --test tests/shared/legacyPromaSessions.test.js tests/shared/clientHealth.test.js tests/shared/clientRegistrationConsistency.test.js`
