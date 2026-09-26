---
summary: "CodeBuddy Code provider notes: where the client stores session transcripts, how titles, turn boundaries and Session Detail read them, and why usage totals still come from tokscale."
ids: [codebuddy]
read_when:
  - Changing or debugging CodeBuddy session discovery, titles or Session Detail
  - Investigating CodeBuddy usage that is missing from the widget
  - Touching providers/codebuddy/transcript.js, providers/codebuddy/sessionMetadata.js or paths.js
  - Considering CODEBUDDY_CONFIG_DIR or a custom scan path for relocated CodeBuddy data
---

# CodeBuddy Code provider

CodeBuddy has three data planes, and they are deliberately separate:

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage (periods, dashboard, history) | the shared usage collector, through `tokscale` | `~/.codebuddy/projects/**/*.jsonl` and the CodeBuddy IDE / VS Code extension logs, parsed by tokscale's `codebuddy.rs` |
| Session metadata (title, turn boundary) | collector enrichment, through `providers/codebuddy/sessionMetadata.js` | the same transcripts, scanned locally |
| Session Detail (per-turn breakdown, prompts, tools) | `parseCodebuddyTranscript()` in `sessionDetail.js`, on demand | the same transcripts, parsed locally |

## Where the data lives

The client keeps one transcript per session, in a directory named after the
working directory it ran in — the same storage shape Claude Code uses:

```
~/.codebuddy/projects/<mangled-cwd>/<session-id>.jsonl
```

`CODEBUDDY_CONFIG_DIR` is deliberately **not** consulted, even though the CLI
resolves its config directory from it. The pinned tokscale declares no override
for this client: its table spells the root as a bare `.codebuddy/projects`,
where Claude and Codex carry `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Following the
client instead of the scan would let the local readers answer for sessions
nothing reported, and one session could then take its usage from one root and
its title or transcript from another. A relocated root therefore keeps token
usage and loses title/Session Detail, exactly as `providers/droid/sessionMetadata.js`
documents for `FACTORY_HOME_OVERRIDE`.

The scan also counts sessions that exist only in the CodeBuddy IDE / VS Code
extension logs (`codebuddy-extension-log`, `CodeBuddy CN`, `CodeBuddyIDE`). Those
have no transcript on disk, so their rows keep their usage and read
“Transcript not found on this machine.” — the same behaviour as a Claude Code
session whose transcript has been pruned. On one machine 317 of the 376
scan-reported sessions resolved to a transcript.

## What a record is

Records are JSONL, one object per line, and the types that matter are:

| `type` | Content |
| --- | --- |
| `message` (`role: 'user'`) | `content: [{type: 'input_text', text}]`, plus the flags below |
| `message` (`role: 'assistant'`) | `content: [{type: 'output_text', text}]`, `status`, and either this record or the call carries the response's usage |
| `function_call` | `name`, `arguments`, and usually the response's usage |
| `function_call_result` | the tool's output; the largest records in the tree live here |
| `reasoning` | the model's thinking (`rawContent`) |
| `ai-title` | `aiTitle` — the generated session title |
| `summary` | a compaction digest, or a copy of the first user message |
| `turn-metrics` | `durationMs`, `tokenDelta` |

Two properties of the format drive the readers:

- **One model response is one `providerData.messageId`**, persisted as either a
  `function_call` (the response asked for a tool) or an assistant message (it
  answered in text). Usage is recorded on exactly one of those records — the
  call when there is one. Measured over 53248 records: 12158 of 12950
  usage-bearing records are calls, against 792 assistant messages, so a reader
  that only looked at assistant messages would find usage for a fifth of turns.
- **`role: 'user'` is shared with client plumbing.** Slash commands, local
  command echo, compaction digests and teammate input all arrive as user
  records. 1382 of 2535 on one machine carry `providerData.skipRun`, and another
  207 carry no flag at all and are recognisable only by the envelope they open
  with (`<command-name>`, `<system-reminder>`, `<local-command-stdout>`,
  `<teammate-message>`, …). `providers/codebuddy/transcript.js` owns both
  predicates, because the metadata scanner and the Session Detail parser must
  agree on what a prompt is.

## Titles and the turn boundary

`providers/codebuddy/sessionMetadata.js` reads one bounded pass per transcript
and answers both halves, the way `providers/claude/sessionMetadata.js` does for
the same reason — a second pass per tick for a field in the same file is waste.

- **Title**: the newest non-empty `ai-title` record. The client rewrites it as
  the session evolves, so the last one wins; a record that cleans down to
  nothing is not an answer and does not erase the title already read. `summary`
  records are deliberately not a title source: the type carries either a
  compaction digest or a copy of the first user message, and both are
  conversation content rather than persisted title metadata — the same call
  `providers/codex/sessionMetadata.js` makes about `preview` /
  `first_user_message`.
- **Turn boundary**: the `status` on the newest assistant response —
  `completed` is a finished turn, `incomplete` one that was dropped or
  superseded. A prompt accepted after a completion clears it, so a session that
  was just prompted does not keep reading as finished until the model answers.
  The three states are forwarded as they are: `undefined` means the transcript
  said nothing, and only that may leave an earlier reading in place.
- The cache keeps a tick at one `stat` per session: it is keyed on file
  identity, size and mtime, and a transcript that changed is re-read in full
  rather than resumed from an offset (one file per tick, the session being
  written right now).
- Records over 64 KiB are dropped rather than retained. Tool output is what every
  oversized record is — one `function_call_result` on a real machine was 2 MB —
  while the reading that can be lost is a turn boundary, never a title (an
  `ai-title` record is a few hundred bytes). 313 of 53248 records exceeded the
  bound and only 3 of those were `message` records.

Timestamps and project attribution need no CodeBuddy-specific code: the shared
`fileSessionMetadata()` reads `cwd` out of the same transcript for the shared
project identity, and the client stamps epoch milliseconds, which the shared
timestamp reader already accepts. `startedAt` comes from the scan's
`firstActiveMs`, since a CodeBuddy session id carries no timestamp.

## Session Detail

`parseCodebuddyTranscript()` in `src/shared/sessionDetail.js` emits one turn per
`messageId`, carrying the tools that response requested and the usage from
whichever of its records had it. A response whose usage never arrived is still
emitted, with `tokensAvailable: false` — the reply and its tools are worth
showing without their numbers, and that is what the shared contract is for.

Token extraction subtracts cached input, because `prompt_tokens` counts it:

```
input = max(0, prompt_tokens - cached)   output = completion_tokens
cacheRead = cached                        reasoning = completion_thinking_tokens  (a subset of output)
```

`cached` is not a stable field across client versions, and summing the wrong one
inflates input by the same amount it loses from cache — one session came out as
9.1M input / 0 cache against tokscale's 1.2M / 7.9M. `transcript.js` checks
`rawUsage.prompt_cache_hit_tokens`, then `rawUsage.prompt_tokens_details.cached_tokens`,
then `usage.inputTokensDetails[].cached_tokens`.

**Verification.** Folding every usage-bearing transcript record this way
reproduces tokscale's own numbers exactly — per-session `input`, `output` and
`cacheRead` matched on 314 of the 316 resolvable sessions on one machine. The
two exceptions are a session that was still being written when the scan ran, and
one the scan counted partly from the extension-log source, which holds no
transcript. The response count also equals tokscale's `messageCount`, which is
the check that the `messageId` grouping is the client's own unit and not an
invention of this parser.

## The VS Code extension's own store

Sessions started from the CodeBuddy VS Code extension never touch the CLI
tree. Their conversations live in the shared extension data dir, one tree per
install and per editor:

```
<CodeBuddyExtension>/Data/<install-id>/VSCode/<editor-uuid>/history/<workspace-hash>/
├── index.json                                  conversations[]: id, name, createdAt, lastMessageAt
└── <conversation-id>/
    ├── index.json                              messages[] (order), requests[] (one model call each)
    └── messages/<message-id>.json              {role, message: "<json>", extra: "<json>", createdAt}
```

The session id tokscale keys these on is the request's `extra.traceId`, not
the conversation id — trace ids are per request, so one conversation with
three model calls is three reported sessions. `providers/codebuddy/extension.js`
walks the history roots (bounded-depth, matching on the `history` directory
name because the two intermediate levels are opaque ids), and per conversation
caches the trace-id → request mapping keyed on the directory's mtime, so a
tick costs one stat per conversation.

From there both reads work without any new data plane:

- **Title**: the workspace index's `conversations[].name`. The workspace's own
  path is not stored anywhere, but the first user message's context envelope
  opens with `Workspace Folder: <path>`, which is what joins these sessions to
  project grouping.
- **Session Detail**: one request is one exchange. Its user messages carry the
  prompt the user actually saw in `extra.sourceContentBlocks` (the `message`
  payload itself is the context-wrapped form), and the request's `usage` is
  the turn: `cachedMissTokens` is the uncached input and `cacheTokens` /
  `cachedWriteTokens` are the cache fields. Verified against a scan: for one
  request the store says 232098 in / 189056 cached and tokscale reports
  43042 / 189056 — the subtraction is exact, including the version where
  `cachedMissTokens` is absent and only the subtraction produces the answer.

The base directories mirror the collector's extension watch roots (`Data`
where those use `Logs`): `%LOCALAPPDATA%` on Windows, `Application Support` on
macOS, and the XDG data home on Linux. There is deliberately no env override —
the same reasoning as `CODEBUDDY_CONFIG_DIR` above applies to this root too.

## WorkBuddy writes the same family

WorkBuddy's `~/.workbuddy/projects/**/*.jsonl` (and 5.5's `~/.workbuddy-ai`
home, which tokscale still scans alongside it) is the same transcript family —
same record types, the same `ai-title`/`status`/`providerData.messageId`
fields, usage on the response's `function_call` or assistant message. Two
differences, both handled by the shared readers in this folder:

- **`custom-title` exists**: the user can rename a conversation, and it
  outranks the generated `ai-title` — the same precedence Claude Code's reader
  gives its `custom-title` record.
- **Older builds group nothing**: `providerData.messageId` can be absent from
  every response record, and their `usage` is a bare snake-case
  `{input_tokens, output_tokens}` with no cache detail. A usage-bearing record
  without a grouping id is its own response; the calls before it ride the next
  turn's tools, the way the Codex parser consumes its pending calls. Verified
  against a scan: a real transcript in this shape folds to the scan's exact
  input, output and message count (1915931 / 27141, 8 messages).

`providers/workbuddy/sessionMetadata.js` binds this folder's readers to
WorkBuddy's two roots; see that provider's own notes for its limits and
credential planes.

## Known gaps

- **No context window.** CodeBuddy records no window size anywhere, and
  `turn-metrics.tokenDelta` is a per-turn delta rather than an occupancy, so
  CodeBuddy has no context gauge — the `contextTokens`/`contextWindow` pair is
  left unset rather than guessed from a model name.
- **Image-only prompts.** `contentText()` reads `input_text` items; no
  `input_image` or `input_audio` part appears in any of the 53248 sampled
  records, so a prompt made only of attachments would not be a boundary here.
  A client version that starts emitting them needs that case added to
  `providers/codebuddy/transcript.js`.
- **Client noise that is neither flagged nor enveloped** (for example a
  `[WARN] Failed to initialize plugins …` line the CLI writes into the
  transcript) still shows as one prompt row. Only envelope-shaped injections are
  recognised.
