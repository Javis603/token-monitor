---
summary: "Codex provider notes: rollout metadata/context, OAuth and RPC quota sources, managed workspaces and system-account switching."
ids: [codex]
read_when:
  - Changing Codex session metadata, T3 title lookup, context occupancy or turn state
  - Changing Codex OAuth/RPC limits, managed accounts or workspace identity
  - Changing Codex login, system-account switching or reset forecasts
---

# Codex

Codex combines a tokscale-backed usage client, local rollout enrichment and a multi-account limits provider. Keep those data planes separate even though they share the `codex` id.

## Session metadata and context

`sessionMetadata.js` joins rollout sessions to Codex's thread databases and, for T3 Code sessions, T3's own thread catalog. T3 drives the same harness but stores generated titles separately; a Codex-only lookup can otherwise fall back to the first user message. Attachment markup and agent boilerplate are stripped before display. Background reviews keep their `sessionKind` rather than masquerading as ordinary chats.

T3 V2 uses `statev2.sqlite`: join `orchestration_v2_projection_threads` to its provider-thread rows through `thread_id`, then match `payload_json.nativeThreadRef.nativeId` to the Codex rollout identity. Never match `provider_session_id`, which can be shared across conversations, or restrict a thread to its current default provider: earlier Codex runs remain valid after a provider switch. A V2 native-ID match is authoritative across all discovered stores, even when deleted or carrying an empty/placeholder title: it suppresses retained V1 tables in the same database and the legacy `state.sqlite` cursor join. Legacy titles are used only for IDs absent from V2. Both stores are read-only, and a genuine Codex-generated `name` still takes precedence.

`sessionContext.js` reads the newest rollout `token_count` event. `info.last_token_usage` is current occupancy and `info.model_context_window` is the actual per-session capacity; cumulative `total_token_usage` is never occupancy. Context, turn state and prompt-cache observations share one decoded session index. The initial scan reads at most the newest 1 MiB for context/cache and extends backward up to 8 MiB only to find a turn boundary, without rereading overlapping bytes. Subsequent append-only scans read only new bytes in bounded chunks and retain the accounting identity and last observation across ticks. Unchanged files reuse the index; replacement, truncation or same-size rewrites reset it. Oversized non-metadata records are skipped with bounded retained memory.

Do not replace the transcript-reported window with a model table. User configuration can change the window for the exact sessions being measured.

Rollout filenames are transcript lookup keys and can contain multiple UUIDs; do not treat every UUID as a resumable conversation or assume a fixed UUID position. Session Details takes its copyable identity from the first `session_meta.id` during the existing on-demand transcript parse, without an extra read or background preload. A multi-UUID key has no copyable ID until that metadata is available. This display identity never replaces the usage/grouping key.

Cache warmth is an optional `promptCache: { observedAt, ttlSeconds }` estimate from that shared rollout index; it adds no separate file read or JSON parse. Valid cache read/write activity starts a fixed 30-minute display estimate regardless of the model name or route, including third-party and custom APIs. This is a product estimate, not a reported Codex or provider TTL; actual cache retention can differ. Cold responses, model changes and compaction clear it. Repeated unchanged `token_count` accounting never refreshes the anchor. The anchor is a response observation, so remaining time may be overstated; quota accounting and successful reuse are not implied. Home, Edge Dock and Sessions share one metrics slot: recent context takes priority, with the context token/window counts and cache countdown available in the shared detail tooltip by hovering its bar or percentage; then a still-valid cache estimate appears after 10 minutes of inactivity, with the last recorded context counts still available on hover. Turn completion alone clears neither reading; the cache countdown ends at the observed TTL.

## Task and delegated-thread usage

The fork's opt-in `npm run codex:usage` command uses `taskUsage.js` and `taskUsageReader.js` for a separate observed-lifetime ledger. It reads local thread relationships and request usage, or imports explicitly supplied App Server/rollout events. It does not modify Tokscale period totals, fetch hosted-cloud account history, or infer dot lineage from display names. Coverage and missing usage remain explicit. See [the task-usage contract and CLI guide](../codex-task-usage.md) before extending these modules.

## Opt-in live service usage

`usageRpc.js`, `usageSync.js` and `usageView.js` power `codex:usage -- --live` and `codex:usage:live`. This separate read-only account/thread view does not change the existing collector or local period totals. Explicit roots use bounded ancestry queries; unavailable mappings, child counters and account continuity remain explicit gaps. Thread service estimates never enter the reported-token ledger. See [live usage, provenance and acceptance boundaries](../codex-live-usage.md).

## Hosted cloud turns and allowance

The `--cloud` source uses `cloudTransport.js`, `cloudUsage.js` and `cloudView.js` to read hosted history and query exact thread/turn estimates. It does not route cloud IDs through the local app-server or add overlapping local/account totals. A forbidden token query preserves unknown token values while independently available quota percentages remain separate. PlanMeter provenance, MIT license, bounded discovery, account isolation and real-account findings are in [hosted cloud usage](../codex-cloud-turn-usage.md).

## Hosted engine event observation

The standalone `scripts/codex-cloud-engine-usage.js` observes engine token notifications for one explicitly attached hosted thread. It is not the billing/allowance reader and does not auto-discover or sum task trees. Counts are copied before delivery to consumers, the current login is checked before event persistence, and output aliases are rejected before attachment. See [live engine capture and acceptance](../codex-cloud-engine-live.md) for real two-connection evidence and incomplete historical/automatic-collection coverage.

## Limits sources

The live account normally reads the ChatGPT/Codex backend with the current `auth.json`. The configured `chatgpt_base_url` selects the matching backend path family. The app-server RPC path is a fallback, not an interchangeable authority.

For a managed account, RPC output is usable only when the isolated auth snapshot is scoped to that account's selected workspace. Otherwise the explicitly scoped OAuth request must succeed. A transient OAuth failure may use a correctly scoped RPC reading; an unscoped live RPC must never be published under a managed workspace.

The live system account stays visible alongside enabled managed accounts. Composite identity keeps same-email workspaces distinct while collapsing the live and managed observation of the exact same login. Managed-account hydration must preserve local collisions rather than silently coalescing them.

Reset-credit data supplements quota when available. Empty quota can receive one bounded retry for plans expected to expose windows; do not turn absence into zero.

Plan labels come from the quota response's plan type. Display `prolite`, `pro` and `promax` as Pro, Pro More and Pro Max, without assuming a fixed quota multiplier from a tier name.

## Login and account switching

Only allowlisted `auth.openai.com` authorization/device URLs may be opened from CLI output. Command discovery and Windows quoting are part of the provider contract because Store/npm installations resolve differently.

Switching the system account rewrites the live auth material for the selected workspace. The write is atomic and identity-checked; UI controls serialize the operation and refresh only after it settles. Managed credentials remain in the main-process store.

## Reset forecast

The optional reset forecast is display enrichment from `codex-resets.com`, not quota authority. Its `active_watch.level: strong` signal can be valid with a null chance percentage; the expiry remains the validity boundary. It has independent success/error cache durations and bounded fetch time. A forecast failure must not alter the provider's real windows.

## Verification

Run the Codex session, limits, login and account-switching tests when changing this note's scope:

```bash
node --test tests/shared/codex*.test.js tests/shared/limitCollector.codex*.test.js tests/shared/sessionContext.test.js tests/electron/codex*.test.js
```

## Desktop live-capture entry

`codex-cloud-capture-desktop.js` wraps the existing explicitly selected cloud event observer with a native UUID dialog, bounded duration and per-run private reports. The separate test-app installer verifies the old package and preserves a rollback backup; it does not install an account-wide scanner or a new archive. See [desktop capture and deployment](../codex-cloud-capture-desktop.md).
