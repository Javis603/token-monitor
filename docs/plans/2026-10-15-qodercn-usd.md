# Qoder CN standard usage accounting

## Scope

Collect real CLI tokens where exposed, value reported CN credits in USD, and use the existing native report/model/session/history path. Preserve configuration, other clients' token accounting and the separate authenticated quota provider. Replace the earlier standalone credits side-plane rather than maintain two accounting systems.

## Decisions

- Qoder CN's documented resource pack is CNY 40 / 1,000 credits. Desktop collection passes the app's effective FX; a pricing revision change refreshes every period/history.
- Native parser caches raw credits and deduplicates request identity before converting. Credit-derived cost replaces token-derived estimates for the same request. Preserve legacy/BYOK behavior and explicit custom-price precedence.
- Native `QODERCN_EXPOSE_TOKEN_USAGE=1` enables future measured tokens. Historical masked counters remain unavailable.
- `qfmodel` maps to Qwen3.8-Flash from the CLI's actual model catalog. Reuse existing model aliases for overrides.
- Remove the abandoned Node credit ledger, portable credits field and renderer additions. Existing files on users' disks are retained.
- Native implementation is in the pinned tokscale fork. The app PR depends on its vendor release; do not describe the old binary as credit-capable. A local-only build must record its actual source and binary integrity separately.

## Acceptance

- Native CLI emits measured token counts and credit-derived USD once per request, including zero-token historical rows.
- Invalid/non-CLI credits do not become costs; copied requests and warm cache do not double count. FX updates reprice raw credits.
- Existing model rows show tokens and USD without a separate style; all periods, sessions and history share those values.
- Unrelated client fixture token/cost output remains unchanged.
- Local package includes the tested native binary, preserves existing data/config and has an independently usable rollback.
- Submit native PR and update app PR/issue with actual checks and release dependency.

## Progress

- Compared Claude, Codex, Qwen, Kiro and Qoder CN native paths.
- Real native token exposure proved; correct model catalog and CN pricing verified.
- Native parser tests pass; package and upstream integration checks in progress.

### Worker FX and local acceptance

The desktop usage collector normally runs in a worker thread, not the main process's currency-module instance. Pass one effective USD-per-credit scalar through the existing serializable runtime configuration; include it in runtime/pricing fingerprints and reconcile the usage runtime when effective CNY FX changes. Scan and graph use the same scalar. Lint plus 93 affected runtime/worker/pricing/anchor tests pass.

The native source build passed real-source credit reconciliation and a four-client fixture comparison: unrelated client token/cost rows are unchanged, measured Qoder counts remain actual tokens, and copied credit requests count once. The signed packaged binary passed direct native execution and dependency loading. Local-only package provenance records both source commits; signing changes executable signature bytes, so the signed artifact integrity is recorded separately from the pre-sign vendor/download digest. No official vendor artifacts have been published.
