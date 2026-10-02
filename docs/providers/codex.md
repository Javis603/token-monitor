---
summary: "Codex provider notes: rollout metadata/context, OAuth and RPC quota sources, managed workspaces and system-account switching."
ids: [codex]
read_when:
  - Changing Codex session metadata, T3 title lookup, context occupancy or turn state
  - Changing Codex OAuth/RPC limits, managed accounts or workspace identity
  - Changing Codex login, system-account switching or reset forecasts
---

# Codex

Codex combines a tokscale-backed usage client, local rollout enrichment, supplementary local-executor observations and a multi-account limits provider. Keep usage and limits separate even though they share the `codex` id.

## Dots local execution

Dots-created local Work/Codex tasks currently expose live App Server counters without writing a local rollout. `localUsageSource.js` observes those counters through the hosted desktop App Server, using the live `CODEX_HOME/auth.json` login. A task qualifies only when its single execution environment matches a running **local** `codex exec-server --environment-id` process and its source is `codex_work_cca` / `aeon_child`; cwd alone never proves device ownership. Cloud coordinators, another computer's executors, ambiguous environments and tasks with native rollout paths are excluded. Normal rollout collection continues unchanged.

The widget and resident agent observe while running; one-shot collection only reads the durable ledger. Discovery checks every five seconds and live changes use the collector's existing bounded debounce. `TOKEN_MONITOR_CODEX_LOCAL_USAGE=0` stops observation without erasing already collected usage. The source uses the existing undici dependency with standard proxy environment variables and `NO_PROXY`; unlike Electron limits fetches, this worker-owned WebSocket does **not** inherit the OS proxy. It never starts turns, changes thread configuration, answers approvals or requests quotas.

`codex-local-usage.sqlite` in the shared data directory stores only counters, request identities and session/project metadata. Transactions and cumulative checkpoints deduplicate notifications across reconnects and the widget/agent. Only observed requests receive a day/model/project attribution; a pre-observation cumulative prefix and gaps while offline are not backfilled. RPC input includes cached input and RPC output includes reasoning; convert to canonical exclusive input and inclusive output, then to the disjoint Codex buckets expected by the shared Tokscale decoder. Pricing uses the same catalog lookup as other locally parsed usage; unavailable prices stay zero, without implying subscription billing.

These requests appear under the existing `codex` client and use the actual thread id (not an inherited fork `sessionId`), the stored task name and `projectIdentity(cwd)`. Today/month/allTime and history consume the same ledger. Native rollout sessions take precedence on identity overlap. The request ledger already provides retention, so `codexLocalSessionKeys` prevents a second copy in the generic session archive and is removed from sync payloads. Session details show observed token entries; conversation text and tool content are not collected. Titles stay local under the existing sync privacy rules. Hosted environment metadata is a desktop extension; connection/discovery failures retry with bounded backoff and leave native collection available.

Manual acceptance: run the updated widget with Codex tracking enabled and the desktop local executor connected, ask Dots to create or continue a local project task, then verify its title/tokens in Sessions and its directory label in Projects. Restart Token Monitor and verify the same totals remain; continue the task and verify only the new consumption is added. Usage before observation began is deliberately outside this acceptance scope.

## Session metadata and context

`sessionMetadata.js` joins rollout sessions to Codex's thread databases and, for T3 Code sessions, T3's own thread catalog. T3 drives the same harness but stores generated titles separately; a Codex-only lookup can otherwise fall back to the first user message. Attachment markup and agent boilerplate are stripped before display. Background reviews keep their `sessionKind` rather than masquerading as ordinary chats.

T3 V2 uses `statev2.sqlite`: join `orchestration_v2_projection_threads` to its provider-thread rows through `thread_id`, then match `payload_json.nativeThreadRef.nativeId` to the Codex rollout identity. Never match `provider_session_id`, which can be shared across conversations, or restrict a thread to its current default provider: earlier Codex runs remain valid after a provider switch. A V2 native-ID match is authoritative across all discovered stores, even when deleted or carrying an empty/placeholder title: it suppresses retained V1 tables in the same database and the legacy `state.sqlite` cursor join. Legacy titles are used only for IDs absent from V2. Both stores are read-only, and a genuine Codex-generated `name` still takes precedence.

`sessionContext.js` reads the newest rollout `token_count` event. `info.last_token_usage` is current occupancy and `info.model_context_window` is the actual per-session capacity; cumulative `total_token_usage` is never occupancy. Context, turn state and prompt-cache observations share one decoded session index. The initial scan reads at most the newest 1 MiB for context/cache and extends backward up to 8 MiB only to find a turn boundary, without rereading overlapping bytes. Subsequent append-only scans read only new bytes in bounded chunks and retain the accounting identity and last observation across ticks. Unchanged files reuse the index; replacement, truncation or same-size rewrites reset it. Oversized non-metadata records are skipped with bounded retained memory.

Do not replace the transcript-reported window with a model table. User configuration can change the window for the exact sessions being measured.

Rollout filenames are transcript lookup keys and can contain multiple UUIDs; do not treat every UUID as a resumable conversation or assume a fixed UUID position. Session Details takes its copyable identity from the first `session_meta.id` during the existing on-demand transcript parse, without an extra read or background preload. A multi-UUID key has no copyable ID until that metadata is available. This display identity never replaces the usage/grouping key.

Cache warmth is an optional `promptCache: { observedAt, ttlSeconds }` estimate from that shared rollout index; it adds no separate file read or JSON parse. Valid cache read/write activity starts a fixed 30-minute display estimate regardless of the model name or route, including third-party and custom APIs. This is a product estimate, not a reported Codex or provider TTL; actual cache retention can differ. Cold responses, model changes and compaction clear it. Repeated unchanged `token_count` accounting never refreshes the anchor. The anchor is a response observation, so remaining time may be overstated; quota accounting and successful reuse are not implied. Home, Edge Dock and Sessions share one metrics slot: recent context takes priority, with the context token/window counts and cache countdown available in the shared detail tooltip by hovering its bar or percentage; then a still-valid cache estimate appears after 10 minutes of inactivity, with the last recorded context counts still available on hover. Turn completion alone clears neither reading; the cache countdown ends at the observed TTL.

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
