---
summary: "Grok Build session metadata fallbacks, disjoint reasoning accounting and request throughput."
ids: [grok]
read_when:
  - Changing what a grok session's title, timestamps or project come from
  - Debugging a missing or mislabelled Grok session list
  - Changing Grok token accounting or throughput
---

# Grok Build

Tokscale owns Grok token parsing. Its unified reader splits `completion_tokens` into disjoint `output` and `reasoning` buckets. The shared `TOKSCALE_DISJOINT_REASONING_CLIENTS` registry in `history.js` lists every client whose reasoning must be folded back into Token Monitor's reasoning-inclusive public output and totals exactly once; usage, History and throughput all read that one registry.

Grok throughput requires a vendored scanner build carrying [upstream #1485](https://github.com/junhoyeo/tokscale/pull/1485), which reads each inference's positive `ctx.model_elapsed_ms` into the existing duration pipeline; the current pin predates it, so Grok reports no timed samples and TPS/TPM stay unavailable. On such a build, matched `timedOutputTokens` and `timedReasoningTokens` come from the same timed messages: timed reasoning joins the output numerator only through the disjoint-client registry, untimed legacy output never enters it, and TPM uses all `timedTokens`, which already include reasoning. The timing estimate includes first-output waiting and differs from Grok's decode-only `tokens_per_sec`.

Days whose source logs remain are rebuilt by a later full scan; archived observations retain their recorded `reasoningTokens`, so older archived days remain understated until a migration folds that back.

The bundled fork supplies session/workspace metadata through `applyTokscaleSessionMetadata`. The local fallback, `src/shared/providers/grok/sessionMetadata.js`, reads one small file per session from `~/.grok/sessions/<url-encoded cwd>/<uuid>/summary.json`. It also checks configured Grok extra scan roots, which may name a Grok home, its `sessions` directory or a descendant. The join is exact: tokscale's `sessionId` is the same bare uuid as the directory name. A non-empty `info.id` in `summary.json` must match it; a missing or blank one is accepted. If more than one persisted summary claims that directory id across cwd buckets or scan roots, the resolver skips it as ambiguous. The workspace directory name is only a place to start. Worktree sessions use a non-empty `source_workspace_dir` for project grouping; other sessions use `info.cwd`. Neither path needs URL decoding.

## Timestamps

`created_at` → `startedAt`. For `lastUsedAt` the order is `last_active_at`, then `updated_at`, then `created_at`, and it is deliberately **not** the latest of them. `updated_at` is when the file was last written, which background work (recaps, title refreshes) moves forward on its own: on one machine 13 of 101 files sit more than ten minutes apart, the widest by eight days. Taking the later value lit a green running mark on sessions abandoned a week ago and floated them above genuinely recent ones. Each fallback is a lower bound instead.

The creation-time fallback is not padding: a row with no parseable time is dropped by the dock outright, so a session that was created and never touched is still worth listing.

Grok writes nanosecond ISO strings (`2026-08-19T07:53:22.948065400Z`). V8 truncates rather than rejects them, but every value is normalized through the registry's `isoFromDate` before it is stored, because `applySessionMetadata` both compares and records the string as given.

## Title

`generated_title`, whitespace-collapsed and capped at 96 code points — the same cap claude, codex and kimi each carry locally (there is no shared cleaner). Grok titles are the writer's own prompt text and run to ~173 code points, so the cap is load-bearing. A blank title yields no `title` field at all rather than an empty one, and the row still resolves on its timestamps.

## Scope

A scoped home is a WSL distro, so host `GROK_HOME` and extra scan roots are ignored there — a host root must never answer a distro's session. `chat_history.jsonl` is never read: it carries no timestamp on any line, so it cannot establish a session's span.

There is no cross-tick cache. The registry rebuilds its map every tick, and a full sweep of ~100 summaries costs single-digit milliseconds.

Roughly 45% of the session directories on a busy machine are subagent sessions, and each resolves to its own row once this adapter lands, so the Sessions list reads busier than the chat sessions alone would suggest.

## Verification

```
node --test tests/shared/grokSessionMetadata.test.js tests/shared/mixedTimingThroughput.test.js tests/shared/history.test.js
```
