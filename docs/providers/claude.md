---
summary: "Claude provider notes: transcript metadata, turn boundaries, OAuth/Web/CLI quota sources, identity and transport."
ids: [claude]
read_when:
  - Changing Claude session roots, titles, turn state or live context parsing
  - Changing retained Claude Desktop discovery or transcript watch policies
  - Changing Claude OAuth, Web session or CLI limits collection
  - Changing Claude account identity, prepaid credits or cookie renewal
---

# Claude

Claude has independent local-usage/session and account-limits planes. A Claude Code transcript is not proof of which Claude account owns a limits row, and a Web or OAuth credential is not a token-history source.

## Usage and session metadata

Aggregate tokens and costs come from tokscale. Its source cache preserves observed compacted Claude history even after the original transcript disappears; deleting the transcript alone does not remove that retained usage. Clearing the corresponding Tokscale cache removes its retained copy. The local adapter in `src/shared/providers/claude/sessionMetadata.js` enriches sessions from `CLAUDE_CONFIG_DIR` or `~/.claude`, checking `projects/` before `transcripts/`.

Native title lookup reads only persisted `custom-title` and `ai-title` records; it never turns prompt text into a title. Custom titles win within the transcript. The index is keyed by file size and mtime, scans appended bytes after the first pass and keeps reads bounded around oversized JSONL records.

For sessions matched to T3 Code, a usable T3 sidebar title takes precedence over both native title records, which can remain stale after T3 renames a conversation. The shared read-only `src/shared/t3SessionMetadata.js` reader matches `claudeAgent` V2 rows by `nativeThreadRef.nativeId`; legacy rows use `resume_cursor_json.resume`, not their app-level `threadId`. V2 matches suppress stale legacy titles even when deleted, empty or placeholders. If T3 supplies no usable title, native metadata remains the fallback. Titles are refreshed independently of transcript changes; context, turn state and cache readings still come from the transcript index.

Legacy Claude lookup requires `provider_session_runtime.provider_name = 'claudeAgent'`. Stores without that column keep native titles because the generic `resume` cursor alone cannot establish provider identity. Codex retains its older compatibility path without this column; Claude does not inherit that exception. Malformed legacy cursors are ignored without hiding other valid matches.

T3-owned delegated Claude sessions can carry an independent parent link, including a Codex parent. This uses the shared [relationship reader](../architecture.md#session-relationships); native Claude subagent usage remains accounted for by the parser and is not synthesized into extra session rows.

If the Claude transcript is unavailable, a T3 title updates only the displayed title and preserves the session's existing activity and transcript metadata. When the transcript becomes available again, its turn boundary and other readings apply normally.

Cached overrides record their T3 source explicitly, independently of whether a transcript exists. A confirmed V2 tombstone, empty title or placeholder invalidates that override within the collection. Previously decorated rows recover their prior title, while fresh native labels are preserved. Cached T3 titles are separated from native metadata before a transcript is read, so a transcript with no title cannot inherit a stale override. Missing or unreadable stores do not invalidate overrides and keep cached T3 titles.

Turn state comes from the newest assistant `stop_reason` plus any genuine user prompt written after it. `tool_use` is not an ended turn. `tool_result`, meta and compaction records are not new user prompts. The adapter emits `true`, `false` or no value deliberately: `false` must clear an older finished state, while no value means there is no evidence.

### Live context occupancy

Claude emits `contextTokens`/`contextWindow` from its transcript for sessions that pass `shouldReadSessionContext()`. Use the last serving `message` or `fallback_message` iteration when present, not the request's cumulative usage rollup. Occupancy is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; `output_tokens` is not part of the current input context. `input_tokens` is required, while missing cache counters mean zero. A malformed present counter, zeroed assistant notice or incomplete usage record must not erase the last valid reading.

An explicit `[1m]` model marker, supported native Claude 1M model ids and recognized provider Sonnet 5 ids map to 1M. Other nonempty model ids map to Claude Code's 200K default, including third-party bridges as a best-effort estimate; do not present that fallback as an authoritative bridge window. A compact boundary or compact summary clears the pair to `0/0` until the next valid assistant response. Oversized JSONL records use bounded head/tail fragments; accept context only from a complete message-level `usage` object and do not mistake nested `model` or `usage` fields in tool content for the response.

Cache warmth is an optional `promptCache: { observedAt, ttlSeconds }` estimate from the same incremental transcript index used for title, context and turn state, with no extra file read or JSON parse, requiring cache activity and a reported 5-minute or 1-hour write tier in the newest serving response. Mixed tiers use the shorter TTL; unknown tiers and compaction hide the estimate. Duplicate assistant records do not refresh it, and sidechain responses are excluded. The anchor is the first available response observation, not the unrecorded request time, so remaining time may be overstated. No status line, plugin or Claude settings changes are needed. Home, Edge Dock and Sessions share one metrics slot: recent context takes priority, with the context token/window counts and cache countdown available in the shared detail tooltip by hovering its bar or percentage; then a still-valid cache estimate appears after 10 minutes of inactivity, with the last recorded context counts still available on hover. Turn completion alone clears neither reading; the cache countdown ends at the observed TTL.

## Retained Claude Desktop usage

The scanner reads retained Code/Cowork `.claude/projects` and `.claude/transcripts` below `local-agent-mode-sessions` and `claude-code-sessions`, plus the Claude conversation IndexedDB store and its external blobs. Its three app roots are home-relative `Library/Application Support/Claude`, `AppData/Roaming/Claude` and `.config/Claude` on every platform; APPDATA and XDG overrides do not relocate them. Host health and WSL discovery share the same registrations.

Desktop Chat, Code and Cowork usage stays under the existing `claude` accounting id. The scanner reconciles retained transcripts against conversation-cache usage. Cumulative balances with no usage date remain undated and are excluded from dated reports, including Token Monitor's bounded all-time scan. This does not establish cross-device or host/WSL mirror deduplication.

Transcript watches retain discovery ancestors and only the `projects` and `transcripts` lanes below `.claude`. Prune dependency/VCS trees before `.claude`, reject directory links in discovery ancestors, at `.claude` and inside lanes, and preserve explicit lane-root directory links and JSONL file links. Keep creation/removal events for sessions added after startup. Apply these rules only to Desktop transcript roots, preserving the union with overlapping sources; IndexedDB and external blobs use separate roots.

Windows native mode still admits file links and observes link removal and supported lane-root directory changes. External file-target changes have the shared [native watcher limitation](../architecture.md#watching); do not disable symlinks globally to work around it.

## Live waiting status

Native Claude Code supplies state through `<configDir>/sessions/<pid>.json`: recognized `waiting`/`busy`/`idle` states or `blocked`/`active`/`idle` tempo values map to activity by `sessionId`. Validate the PID domain and process start identity on each read; dead or recycled PIDs are not evidence. Linux records use `linux:<machine-id>:<pid-namespace>` and compare `procStart` with field 22 from `/proc/<pid>/stat` (start-time ticks), rejecting zombie/dead states. Darwin and Windows retain their existing process-start checks. Desktop-hosted records, scoped WSL homes, unreadable records and unsupported probes retain transcript fallback. No Claude settings changes are required.

Ignore live observations and pre-token rows whose cwd matches the probe selected by `src/shared/providers/claude/probe.js`. Resolve parent aliases only after validating the current leaf; linked leaves must never hide their target's sessions. POSIX filtering requires the same owner/rwx checks as preparation; unreadable or unsafe leaves keep real sessions visible, and a missing leaf matches only lexically. Keep the legacy `os.tmpdir()/token-monitor-claude-probe` match lexical, including macOS `/var`–`/private/var` aliases, so a planted link cannot hide a project. The synchronous filter omits macOS ACL checks: an owned `0700` project with an Allow ACL reached through a parent alias may have activity/pre-token rows hidden despite launch being refused; token totals and files are unaffected. Registry names alone do not identify probes, and real sessions without transcripts remain eligible.

T3 V2 pending approvals and questions match the `claudeAgent` driver and `nativeThreadRef.nativeId` to the current run. Validate the server incarnation and request response capability; verified T3 running/waiting takes precedence over the registry. Terminal idle uses the latest run completion or message-question resolution time, expires without renewal and yields to a live native registry. A message-answerable question can remain waiting after model completion until answered or cancelled.

The [shared activity pipeline](../architecture.md) owns refresh, patches and thirty-second expiry. Missing evidence clears the prior observation to `unknown`. Only state and observation time are published; registry prompts, paths and process identity remain local. Pre-token rows use local-only `nativeSessions` and disappear on idle, source loss or replacement by unarchived usage rows. Sessions, Home and Edge Dock share waiting state; waiting rows do not count as running. Without reliable evidence, the existing ten-minute transcript rules apply.

## Limits source order

`fetchClaudeLimits()` uses these mutually exclusive paths:

1. an explicitly configured Claude Web `sessionKey`;
2. Claude Code OAuth credentials discovered from env/file, Windows Credential Manager or macOS Keychain;
3. the authenticated Claude CLI usage screen as a fallback only for not-configured, rate-limited, unavailable or generic OAuth failures.

An identity-resolution failure after successful OAuth quota is not allowed to fall through and mint a differently keyed CLI row. The limits runtime retains the previous stable account instead.

CLI `/usage` prefers print mode on recognized stable releases at or above `2.1.178`, a conservative compatibility gate. Older, prerelease or unknown versions use the original path: PTY on macOS/Linux, direct `/usage` with stdin closed on Windows. Ordinary version/print failures or output without parseable session quota fall back once. Every attempt revalidates its cwd; unsafe-directory/pin failures, rejected required flags, overflow, cancellation or cleanup failure stop without fallback. Timed-out or cancelled print processes must finish cleanup before fallback starts. Cleanup covers ordinary POSIX process-group descendants and Windows `.cmd` trees, but not deliberately daemonized descendants. Delegated macOS `/status` remains PTY-based: printed quota may be cached and does not prove an OAuth refresh.

POSIX uses `claude-probe` under `sharedDataDir()`, with the `claudeProbeDir` dependency override retained. Windows fixes the probe below `os.userInfo().homedir` at `AppData\Local\Token Monitor\claude-probe`, ignoring environment/home/shared-data overrides for this cwd only. An unavailable, relative or UNC OS profile fails without a shared/temp fallback. Activity filtering uses the same path selection.

Preparation refuses files, symlinks and junctions without deleting data, rewriting settings or repairing existing directories. POSIX requires current-user ownership and private rwx bits (`(mode & 0777) === 0700`, allowing inherited setgid), plus no macOS extended Allow ACL. Parent paths are resolved without auditing or chmod; shared groups are not assumed private. Python runs with `-I` to prevent module imports from cwd or user paths, then reopens and pins the checked leaf by device/inode/owner/mode before launching. A parent writer can still cause refusal or path replacement; project/local settings must remain excluded. Same-user/admin control is outside this boundary.

Windows relies on an already-private local profile, AppData parents and existing leaf; it does not audit owner/DACLs or atomically pin cwd. Shared/network or junction-redirected layouts and broadened ACLs are unsupported and not all detected. Node mode bits do not establish Windows privacy.

`/usage` and delegated `/status` probes use `--setting-sources user`, inline hook/deep-link disabling, and `--strict-mcp-config`. Preserve these restrictions on fallback; unsupported required flags fail closed. Print additionally disables built-in tools with `--tools ""`; the legacy empty `--allowed-tools` argument does not disable tools. Managed Claude policy can override settings. The PTY must explicitly confirm workspace trust and recognize the normal input prompt before sending commands; incomplete or unfamiliar renderings fail rather than receiving blind Enter input. Intentional shutdown preserves captured output, while observed early failures reject. Concurrent probes share no mutable settings file. The minimum CLI version supporting all required flags is unknown; other PTY renderings may fail. Linux/Windows real-account acceptance remains outstanding.

OAuth usage refreshes reactively after unauthorized responses. Non-macOS platforms may also refresh shortly before expiry; macOS avoids proactive delegated refresh because it spawns Claude Code. Windows credential-file discovery includes running WSL homes when no explicit config root overrides it.

CLI subprocesses set `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` to suppress prompt history/transcripts, including PTY `/usage` and `/status`. Print also passes `--no-session-persistence`; that flag does not replace the environment setting for interactive probes. Existing transcripts/imported copies are untouched; account-side session creation is unverified.

## Usage-limit reset grants

Both usage responses carry Anthropic's reset coupons in a `cedar_ember` block only when the request asks for it, so every OAuth and Web usage call sends `cedar_ember=1` — the same request, not an extra fetch. Grants that still hold resets and have not reached `ends_at` map onto `provider.resetCredits` with per-grant detail (label, cleared windows, usability flags); spent and lapsed grants are dropped so the count never promises a reset the account cannot use.

The OAuth endpoint also gates the block on client surface: a user-agent that is not Claude Code gets `eligible: false` with `ineligible_reason: "surface"` and no grants, so the OAuth usage call presents as `claude-cli/<version> (external, cli)` — the credential is a Claude Code token. Web usage calls are unaffected because they already present as the browser.

`seven_day_overage_included` in a grant's `clears` reads like a modifier on the weekly clear, but Claude Code's own label map calls it "Fable limit" — the credits-backed model's weekly bucket. Most accounts never see that bucket, so it folds into the general Weekly entry when `seven_day` is also cleared and lists as `Fable weekly` only when it is the sole weekly coverage. The display is read-only: the claim endpoint is deliberately not wired, so nothing in the app can spend a grant. A second reset program (`juniper_tide`) exists but is not collected.

## Claude Web

The stored value must be one bare `sk-ant-…` session key or canonical `sessionKey=…`; arbitrary Cookie headers are rejected. Web collection has priority when configured and uses Electron's dedicated native request adapter. That adapter preserves raw `Set-Cookie` headers and aborts the underlying request, which ordinary fetch handling cannot guarantee here.

The settings form discovers organizations after a session key is pasted. Chat-capable organizations are offered first; if there are none, it offers non-API-only organizations, then the remaining valid organizations. One eligible organization is selected automatically; when several are available, the user chooses one by name and the selected organization ID is saved beside the credential. Usage, account membership and prepaid balance all use that ID. A missing selection with several eligible organizations, or an ID no longer eligible for the picker, leaves limits unavailable instead of silently displaying another organization's data. Changing the selection invalidates the Claude limits lane. Cached identity is reused after an account lookup failure only when its organization ID matches the current selection. Session-key rotation is observed across every response; if discovery rotates the key before the user chooses an organization, main holds the renewed key until the choice is saved without returning it to the renderer. Later requests in the same probe use the renewed key even if persistence loses a race.

A cold identity cache requires the account endpoint. A transient identity failure may reuse a cached stable identity, but quota without any stable identity is unavailable rather than published under a credential-derived key. Authentication errors do not silently fall through to another local account. A Cloudflare challenge is unavailable, not unauthorized.

When account and organization UUIDs are both available, Claude Web and OAuth quota identity includes both. This keeps different organizations under one login separate across devices while allowing the same organization to deduplicate across sources. OAuth profiles without an organization UUID retain their account-level identity. Older collectors with account-only keys may temporarily show a separate row until every device uses the organization-scoped key.

Prepaid balance is best effort and cached more slowly than usage. A failed or refused prepaid endpoint must not erase the quota row. Transient failures retain the last balance; durable refusal is backed off. An unfunded zero pool is hidden when usage credits are disabled, while a funded or exhausted relevant pool remains visible. The provider emits its credits window explicitly without inventing a percentage meter.

## Verification

For retained Desktop discovery and watch rules, run `node --test tests/shared/claudeDesktopWatch.test.js tests/shared/tokscaleUpstreamSources.test.js`. Run the Claude session, limits and Electron transport tests when changing those parts of this note:

```bash
node --test tests/shared/claudeProbe.test.js tests/shared/claudePrintedUsage.test.js tests/shared/claudeSessionActivity.test.js tests/shared/claudeSessionMetadata.test.js tests/shared/limitCollector.claude.test.js tests/electron/claudeWebFetch.test.js
```
