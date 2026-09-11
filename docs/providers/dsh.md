---
summary: "DeepSeek Harness (dsh) provider notes: where the harness stores transcripts, how a versioned transcript name is discovered, and why the usage totals come from tokscale rather than a local reader."
read_when:
  - Changing or debugging DeepSeek Harness (dsh) session discovery or Session Detail
  - Investigating DSH usage that is missing from the widget
  - Touching providers/dsh/sessionFiles.js, providers/dsh/sessionDetail.js or paths.js
---

# DeepSeek Harness (dsh) provider

DSH has two data planes, and they are deliberately separate:

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage (periods, dashboard, history) | the shared usage collector, through `tokscale` | DSH session transcripts, parsed by tokscale's `dsh.rs` |
| Session Detail (per-turn breakdown, prompts) | `providers/dsh/sessionDetail.js`, on demand | the same transcripts, parsed locally |

## Where the data lives

The harness resolves its home from `DSH_HOME`, falling back to `~/.dsh`, and writes one
transcript per session:

```
<dshHome>/sessions/<encoded-cwd>/<session-id>/session[.<version>].jsonl[.zstd]
```

| File | Content |
| --- | --- |
| `session.v3.jsonl.zstd` | what a v3+ harness writes. The upgrade re-encodes the existing transcript into this new file and leaves the old one in place instead of rotating it. |
| `session.jsonl.zstd` | what older harnesses wrote. zstd, one frame per flush, so a live scan can catch a torn trailing frame. |
| `session.jsonl` | uncompressed variant (tests / degraded path). |

Records are `{type, seq, time, data}` envelopes: token usage in
`data.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,reasoningTokens}`, the
model/provider in `data.message.source.{model,provider}`.

## Discovery rules

`sessions/<project>/<session>/` can hold **both** encodings of one session at once, and the
versioned file is the live one — the unversioned file stopped being appended to when the harness
upgraded. So `sessionFiles.js` matches the version segment generically
(`session[.vN].<ext>`, numeric — the harness's own convention) and lists a session's versioned
transcript before its stale predecessor. Callers that stop at the first match (Session Detail,
the header index used for session timestamps) therefore read the file the harness is still
writing, and a session whose only transcript is versioned is found at all.

Token Monitor's pinned tokscale build uses the same canonical generic-version matcher. Keeping
the two discovery rules aligned means a transcript visible in dashboard usage can also be opened
in Session Detail. The npm 4.15.1 base predates this support; the vendor override supplies it
until an official tokscale release includes the fix.

## Session Detail

`sessionDetail.js` reads the transcript on demand only (nothing is uploaded) and owns the
record rules shared by every DSH reader:

- `user/message` events are not all user-typed prompts. `data.source.kind` is `user` for what the
  person typed, but `agent-instructions`, `plugin` and `skill-catalog` for harness-injected
  context — only `kind === 'user'` becomes a prompt bubble.
- A forked session's log is seeded with a byte-for-byte copy of its parent's events up to
  `session.seedLength`; that prefix is credited to the parent, so it is skipped here. Tokscale
  does the same (`seq < seed_length`).
- dsh's writer can replay an already-flushed line; a replayed record is deduped on message
  identity + time + routing + token signature, matching tokscale's own guard.

`usageTokens()` passes `outputTokens` through unmodified: dsh's reasoning is a subset of output,
and tokscale subtracts then re-adds reasoning, so the net total is reasoning-inclusive output.
Subtracting here would under-count every reasoning-heavy session by exactly its reasoning
tokens.

## Usage totals stay on the tokscale path

The collector does not read dsh transcripts for period or dashboard totals. The pinned tokscale
build already discovers the versioned name, so those sessions stay on the normal usage path:

- tokscale's `dsh.rs` parses these records correctly once they are exposed under a name it
  matches — verified by exposing a v3 transcript under the unversioned name, which reproduced
  the exact token/message counts;
- it also unions every matched transcript of one session and dedupes by record signature, so a
  home that kept both encodings is not double-counted (verified: the same records under two
  matched names still report one session's count, and so does a partial copy beside a complete
  one).

Native scans honor `DSH_HOME`. An explicit `--home <dir>` disables host environment roots and
uses `<dir>/.dsh` instead, so per-home WSL scans remain scoped to the requested distro home.
