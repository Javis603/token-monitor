# Local usage ledger token recovery

Cherry Studio's overview retains invocation records that its Claude transcripts do not cover. CC Switch also preserves archived request totals after the original session logs disappear. Reading only transcripts can therefore show a smaller token total than either application's usage screen.

The widget and headless agent read these additional sources through `src/shared/usage/localTokenLedgers.js`. The reader selects token counts, model names and timestamps only. It does not select prices, costs, API keys, prompts or responses, and it never writes to either source database.

Cherry Studio follows the existing platform-specific `cherrystudio-db` source root. Its explicit `total_tokens` is authoritative; when absent, recovery uses `input_tokens + output_tokens`. Cache counts are already inside input and reasoning is already inside output. Agent-mode and embedding invocations participate. A legacy aggregate participates only when no invocation identifies the same message and message kind.

CC Switch uses `~/.cc-switch/cc-switch.db`. Its detailed `proxy_request_logs` and archived `usage_daily_rollups` form one read transaction. Input semantics `0` retain the legacy Codex cache-read subtraction, `1` removes both included cache buckets, and `2` is already fresh input. Legacy Claude input is fresh. Unknown semantics are skipped. Recovery currently covers the existing Claude Code and Codex client IDs.

## Overlap and attribution

Both sources overlap native transcripts. Historical rollups have no request IDs, so exact cross-source request deduplication is unavailable. For each client/model and Today/month/allTime window, recovery uses the larger of the retained native token total and the ledger token total. It adds only the difference, rather than adding both sources. Existing provider-prefixed model labels stay intact. If native client tokens lack a complete model breakdown, recovery leaves them alone instead of assuming they are unrelated.

This is a lower bound. When both sources contain different missing requests for the same model and period, their exact union can exceed the recovered total. Recovery does not claim per-request completeness or force totals down to match another application's screen.

Recovered differences are unclassified tokens. They have no invented cache/output split, session, project, request count or generation duration. Existing prices and every cost breakdown remain unchanged. Historical daily charts retain their native source allocation; they can differ from the recovered period totals.

## Collection and retention

Recovery runs after session archive projection, before publishing or project rollups. Recovered differences never enter native collector anchors or session archive capture. Repeated projection is idempotent, and a native transcript that catches up removes the difference naturally. Archive-disabled agent projection also keeps the collector's original summary untouched.

Database and WAL metadata invalidate the in-memory read cache. SHM changes do not. Cherry Studio's existing DB/WAL watcher triggers collection. CC Switch totals refresh on the next ordinary collection/publication; this change adds no CC Switch watcher. Missing, corrupt or incompatible sources leave native usage available and do not replay stale cached ledger rows.

The same projection runs in the Electron usage worker, its in-process fallback and the headless agent, including read-only dry runs. Progressive previews keep their missing periods missing, and allTime respects the configured start date.

## Verification

```sh
node --test tests/shared/localTokenLedgers.test.js tests/shared/usageTransform.test.js
npm run verify
```

Fixtures cover token-only ledgers with no price columns, cache/reasoning subsets, total-only and migration records, CC Switch input semantics, platform roots, WAL updates, corrupt sources, date boundaries, overlap, unchanged prices and separation from native archive capture.
