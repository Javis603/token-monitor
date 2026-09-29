---
summary: "Grok Build sessions are named from the local summary.json. Tokscale reports grok tokens with no timestamp, title or project at all, so the card had nothing to list."
ids: [grok]
read_when:
  - Changing what a grok session's title, timestamps or project come from
  - Debugging a missing or mislabelled Grok session list
---

# Grok Build

Tokscale parses grok end to end and reports tokens, cost, model and message counts correctly. What it does not report is anything that *identifies* a session: its `ModelUsageJson` carries only `client, mergedClients, sessionId, model, provider, input, output, cacheRead, cacheWrite, reasoning, messageCount, cost, performance`. No timestamp, no title, no project — for any client, not just grok.

That is not cosmetic. `edgeDock/presentation.js` drops a session whose `lastUsedAt` and `startedAt` are both unparseable, so every grok row was discarded and the Grok card showed quota and totals with no sessions. `applyTokscaleSessionMetadata` cannot fill the gap either: it reads `json.sessions` / `json.workspaces`, arrays this tokscale build never emits, so it early-returns for every client.

`src/shared/providers/grok/sessionMetadata.js` is therefore the whole answer, reading one small file per session from `~/.grok/sessions/<url-encoded cwd>/<uuid>/summary.json`. It also checks configured Grok extra scan roots, which may name a Grok home, its `sessions` directory or a descendant. The join is exact: tokscale's `sessionId` is the same bare uuid as the directory name and `summary.json`'s `info.id`. The workspace directory name is only a place to start. Worktree sessions use a non-empty `source_workspace_dir` for project grouping; other sessions use `info.cwd`. Neither path needs URL decoding.

## Timestamps

`created_at` → `startedAt`. For `lastUsedAt` the order is `last_active_at`, then `updated_at`, then `created_at`, and it is deliberately **not** the latest of them. `updated_at` is when the file was last written, which background work (recaps, title refreshes) moves forward on its own: on one machine 13 of 101 files sit more than ten minutes apart, the widest by eight days. Taking the later value lit a green running mark on sessions abandoned a week ago and floated them above genuinely recent ones. Each fallback is a lower bound instead.

The creation-time fallback is not padding: a row with no parseable time is dropped by the dock outright, so a session that was created and never touched is still worth listing.

Grok writes nanosecond ISO strings (`2026-08-19T07:53:22.948065400Z`). V8 truncates rather than rejects them, but every value is normalized through the registry's `isoFromDate` before it is stored, because `applySessionMetadata` both compares and records the string as given.

## Title

`generated_title`, whitespace-collapsed and capped at 96 code points — the same cap claude, codex and kimi each carry locally (there is no shared cleaner). Grok titles are the writer's own prompt text and run to ~173 code points, so the cap is load-bearing. A blank title yields no `title` field at all rather than an empty one, and the row still resolves on its timestamps.

`title` is on the shared `SESSION_TEXT_KEYS` list, so the Hub strips it on the ingress path. The device still uploads it.

## Scope

A scoped home is a WSL distro, so host `GROK_HOME` and extra scan roots are ignored there — a host root must never answer a distro's session. `chat_history.jsonl` is never read: it carries no timestamp on any line, so it cannot establish a session's span.

There is no cross-tick cache. The registry rebuilds its map every tick, and a full sweep of ~100 summaries costs single-digit milliseconds.

Roughly 45% of the session directories on a busy machine are subagent sessions, and each resolves to its own row once this adapter lands, so the Sessions list reads busier than the chat sessions alone would suggest.

## Verification

```
node --test tests/shared/grokSessionMetadata.test.js
```
