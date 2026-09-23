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

## Limits sources

The live account normally reads the ChatGPT/Codex backend with the current `auth.json`. The configured `chatgpt_base_url` selects the matching backend path family. The app-server RPC path is a fallback, not an interchangeable authority.

For a managed account, RPC output is usable only when the isolated auth snapshot is scoped to that account's selected workspace. Otherwise the explicitly scoped OAuth request must succeed. A transient OAuth failure may use a correctly scoped RPC reading; an unscoped live RPC must never be published under a managed workspace.

The live system account stays visible alongside enabled managed accounts. Composite identity keeps same-email workspaces distinct while collapsing the live and managed observation of the exact same login. Managed-account hydration must preserve local collisions rather than silently coalescing them.

Reset-credit data supplements quota when available. Empty quota can receive one bounded retry for plans expected to expose windows; do not turn absence into zero.

## Login and account switching

Only allowlisted `auth.openai.com` authorization/device URLs may be opened from CLI output. Command discovery and Windows quoting are part of the provider contract because Store/npm installations resolve differently.

Switching the system account rewrites the live auth material for the selected workspace. The write is atomic and identity-checked; UI controls serialize the operation and refresh only after it settles. Managed credentials remain in the main-process store.

## Reset forecast

The optional reset forecast is display enrichment from `codex-resets.com`, not quota authority. It has independent success/error cache durations and bounded fetch time. A forecast failure must not alter the provider's real windows.

## Verification

Run the Codex session, limits, login and account-switching tests when changing this note's scope:

```bash
node --test tests/shared/codex*.test.js tests/shared/limitCollector.codex*.test.js tests/shared/sessionContext.test.js tests/electron/codex*.test.js
```
