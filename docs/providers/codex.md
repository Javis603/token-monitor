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

`sessionContext.js` reads the newest rollout `token_count` event. `info.last_token_usage` is current occupancy and `info.model_context_window` is the actual per-session capacity; cumulative `total_token_usage` is never occupancy. The reader uses bounded tail windows and returns no gauge when the newest event is beyond them. Turn-end detection grows through bounded tail windows up to its cap. Both caches invalidate on size and mtime.

Do not replace the transcript-reported window with a model table. User configuration can change the window for the exact sessions being measured.

Cache warmth is an optional `promptCache: { observedAt, ttlSeconds }` estimate from a bounded rollout tail (1 MiB, widened up to 8 MiB when a long turn pushes its model declaration outside the initial tail). It requires a recognized GPT-5.6 or GPT-6.0/6.1 model and cache read/write activity, and applies the documented 30-minute API lifetime as an explicitly labeled estimate, not a Codex expiry receipt. Unknown models, cold responses and compaction hide it. Repeated unchanged `token_count` accounting never refreshes the anchor. The anchor is a response observation, so remaining time may be overstated; quota accounting and successful reuse are not implied. Home, Edge Dock and Sessions share one metrics slot: recent context takes priority, with the context token/window counts and cache countdown available in the shared detail tooltip by hovering its bar or percentage; then a still-valid cache estimate appears after 10 minutes of inactivity, with the last recorded context counts still available on hover. Turn completion alone clears neither reading; the cache countdown ends at the observed TTL.

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
