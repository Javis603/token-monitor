---
summary: "DeepSeek Harness (dsh) provider notes: transcript discovery, session detail, historical source evidence and authoritative tokscale totals."
ids: [dsh]
read_when:
  - Changing or debugging DeepSeek Harness (dsh) session discovery, titles or Session Detail
  - Investigating DSH usage that is missing from the widget
  - Changing DSH historical platform, account or subscription/API attribution
  - Touching providers/dsh/sessionFiles.js, providers/dsh/sessionDetail.js, providers/dsh/usageSources.js or paths.js
---

# DeepSeek Harness (dsh) provider

DSH has four data planes with separate authority:

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage (periods, dashboard, history) | the shared usage collector, through `tokscale` | DSH session transcripts, parsed by tokscale's `dsh.rs` |
| Local session metadata (timestamps, persisted title) | collector metadata enrichment in `collector.js`, through `providers/dsh/sessionFiles.js` | transcript header, file metadata and the latest `session/title`, parsed locally |
| Historical usage source (platform, anonymous account, access) | `providers/dsh/usageSources.js`, after native usage collection | accepted transcript turns joined by response ID to Magpie's local answering-provider ledger |
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
the header index used for session timestamps and titles) therefore read the file the harness is still
writing, and a session whose only transcript is versioned is found at all.

Token Monitor's pinned tokscale build uses the same canonical generic-version matcher. Keeping
the two discovery rules aligned means a transcript visible in dashboard usage can also be opened
in Session Detail. The npm 4.15.1 base predates this support; the vendor override supplies it
until an official tokscale release includes the fix.

## Local session metadata

The collector enriches local session rows from the preferred transcript without changing token
accounting. It takes the session start from the transcript header, last activity from the file
mtime, and folds the latest durable `session/title` event as the conversation title. It never
derives a title from `user/message` or `session/title-llm-request` content.

Title reads retain complete plain-JSONL or zstd-frame boundaries for incremental refreshes. Before
reusing an append offset, `sessionFiles.js` verifies the file identity and a bounded head/tail
fingerprint; a rewrite or generation change resets the fold, while an unfinished tail is replayed
on the next refresh. DSH validates titles before persistence, so Token Monitor preserves
`event.data.title` rather than applying a separate display limit. Resolved titles remain local and
are not added to the device wire record.

## Session Detail

`sessionDetail.js` reads the transcript on demand only (nothing is uploaded) and owns the
record rules shared by every DSH reader:

- `user/message` events are not all user-typed prompts. `data.source.kind` is `user` for what the
  person typed, but `agent-instructions`, `plugin` and `skill-catalog` for harness-injected
  context — only `kind === 'user'` becomes a prompt bubble.
- A forked session's log starts with a byte-for-byte copy of its parent's events. Legacy headers
  expose the exact cut as `session.seedLength`; current v3 headers use `isSeeded: true`, and the
  cut is the last `session/end-seed` marker whose data has `inherited: true`. Session Detail
  supports both forms and skips the inherited prefix. An ordinary untagged resume marker is not
  a fork cut.
- dsh's writer can replay an already-flushed line; a replayed record is deduped on message
  identity + time + routing + token signature, matching tokscale's own guard.

Detail lookup and parsing run asynchronously inside the session-detail worker. The
reader uses 64 KiB chunks for plain JSONL and Node's streaming Zstd decoder for
compressed transcripts, including a single frame whose decoded output is larger
than the V8 string limit. It retains only prompt, usage and lineage fields, not
raw tool output or attachments. Parsed events and deduplication state still grow
with the number of relevant records; streaming does not bound the complete result.

Each decoded JSONL record is limited to 16 MiB, matching Claude/Codex detail
loading. Oversized records and filesystem read errors discard the entire detail
and use the existing error messages; `ENOENT` remains a missing result eligible
for WSL fallback. Complete Zstd frames are committed only after successful
decoding, so a checksum-corrupt frame cannot contribute usage or resurrect later
frames. A torn final frame retains its recoverable records, matching the existing
DSH decoder's prefix-recovery behavior. Header lookup retains only the first
non-empty record, verifies its compressed frame before trusting the id, and keeps
the directory-name fallback without decoding the remaining frames.

`usageTokens()` passes `outputTokens` through unmodified: dsh's reasoning is a subset of output,
and tokscale subtracts then re-adds reasoning, so the net total is reasoning-inclusive output.
Subtracting here would under-count every reasoning-heavy session by exactly its reasoning
tokens.

## Historical usage source evidence

`usageSources.js` enriches only DSH rows already returned by tokscale. It discovers the preferred transcript through the existing header index, honors the same explicit home and custom scan roots, and calls `parseDshDetailRecords(records, { includeUsageSource: true })`. The parser's native turn acceptance, replay deduplication and inherited-prefix rules remain authoritative. Successful messages use top-level usage when present; attempts use final stream usage. Compaction summary turns are supported. The source fields come from `data.message.source.{provider,model,replayState.response.responseId}`; message/account proximity does not substitute for an ID.

For each accepted positive-output turn in the native scan's local calendar window, the normalized model must match the row. Its response ID must match a non-conflicting Magpie ledger `response_id`, and the ledger's final platform and inclusive output count must exactly equal the transcript's provider and output. Input is deliberately not a matching key because cache inclusion differs between the schemas. The ledger's answering account, rather than the session creator or current login, supplies the anonymized account/access evidence described in [the shared provider rules](README.md#historical-usage-source-evidence). Failed joins preserve the transcript platform with an empty account and `accessType: 'unknown'`.

DSH emits only `usageSourceReferences: [{ usageSource, outputTokens, lastUsedAt }]`, grouped by source and retaining each source's latest turn time. These references can identify multiple platforms/accounts in one model row without assigning native duration to any of them. It does not set a whole-row `usageSource` or timed `usageSources`; account-attributed output speed is therefore unavailable from this enrichment alone. Original native throughput, where present, stays unattributed. Ledger `ms` and `ttft_ms` are never imported, and references neither replace tokscale output nor add another token total. Shared validation rejects an over-allocation and places uncovered native output on the row's observed or unknown source.

The attribution reader skips `user/message` records, bounds each scan to 50,000 retained records and reuses up to 256 stable file snapshots. File identity, size and timestamps must remain unchanged during parsing. Oversized, unstable, unreadable or unavailable transcript/ledger evidence leaves provenance unknown; aborts propagate. It shares the existing JSONL/Zstd reader but retains only derived turn time, counters and source evidence in its cache. Calendar-window references use the accepted turn time; they do not create speed observation times. The model-speed detail's `referenceOnly` rows and selected-range limitations are documented in [model output speed](../model-output-speed.md#historical-source-attribution).

## Usage totals stay on the tokscale path

The collector's local transcript reads enrich metadata, detail and historical identity; period and dashboard token/duration totals still come only from tokscale. The pinned build already discovers the versioned name, so those sessions stay on the normal usage path:

- tokscale's `dsh.rs` parses these records correctly once they are exposed under a name it
  matches — verified by exposing a v3 transcript under the unversioned name, which reproduced
  the exact token/message counts;
- it also unions every matched transcript of one session and dedupes by record signature, so a
  home that kept both encodings is not double-counted (verified: the same records under two
  matched names still report one session's count, and so does a partial copy beside a complete
  one).

Native scans honor `DSH_HOME`. An explicit `--home <dir>` disables host environment roots and
uses `<dir>/.dsh` instead, so per-home WSL scans remain scoped to the requested distro home.

## Verification

Run `node --test tests/shared/dshUsageSources.test.js tests/shared/dshSessionDetail.test.js tests/shared/magpieUsageLedger.test.js` for exact response/provider/output joins, multiple historical identities, unknown fallbacks, native period ownership, custom roots, seeded-prefix/replay handling, ledger cache refresh and cancellation. The source/ledger fixture tests also assert that ledger durations do not populate native timing; they do not establish complete coverage of a real user's historical requests.
