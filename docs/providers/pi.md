---
summary: "Pi (pi.dev) provider notes: where the agent stores session transcripts and how Session Detail reads them, while usage totals still come from tokscale."
ids: [pi]
read_when:
  - Changing or debugging Pi Session Detail
  - Investigating Pi usage that is missing from the widget
  - Touching providers/pi/paths.js or the pi branch of sessionFiles.js/sessionDetail.js
---

# Pi (pi.dev) provider

Pi is a tokscale-parsed tracked client: usage, sessions and costs come from the shared collector during the scan. Only Session Detail is read locally, because tokscale has no per-turn view to hand back.

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage (periods, dashboard, history) | the shared usage collector, through `tokscale` | Pi session transcripts, parsed by tokscale |
| Session Detail (per-turn breakdown, prompts) | `sessionDetail.js` with `providers/pi/paths.js`, on demand | the same transcripts, parsed locally |

## Where the data lives

Pi resolves its agent directory from `PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent`, and writes one transcript per session under a folder named after the working directory:

```
<agentDir>/sessions/<encoded-cwd>/<ISO-timestamp>_<sessionId>.jsonl
```

The session id is a **suffix** of the filename, not the basename, so the shared `findTimestampedSessionFiles` helper matches `_<sessionId>.jsonl` rather than `resolveSessionFile`'s basename walk used by Claude/Codex/CodeBuddy.

The bundled Tokscale scanner uses the fixed home-relative `.pi/agent/sessions` root and does not honor `PI_CODING_AGENT_DIR`. Session Detail uses that same root, including under a scoped WSL home, so an environment override cannot redirect a listed session to a different transcript tree. Sessions stored only in an overridden Pi directory are not tracked by this integration.

## Record shape

Each line is one entry `{type, id, parentId, timestamp, message}`; only `type: "message"` carries conversation. `message.role` is one of `system`, `user`, `assistant` or `toolResult`.

A user message is always a real prompt boundary: tool output arrives as its own `toolResult` role and compaction summaries as their own `compaction` entry, so neither is mistaken for a prompt. Each assistant message is one API response with its own `usage`, so — unlike Claude — nothing has to be de-duplicated across content blocks.

Session Detail also counts top-level `usage` entries (including `kind: "cache_warm"`), `compaction.usage`, `branch_summary.usage`, and `toolResult` message usage, matching [Pi's session statistics](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/agent-session.ts#L4204-L4238). These billed operations remain in the shared exchange breakdown and period filtering, with distinct usage labels; they do not consume reply numbers or increase the conversation turn count. Older summaries without usage contribute nothing: `tokensBefore` describes existing context, not newly billed tokens.

`usage` follows OpenAI's convention: `input`/`output`/`cacheRead`/`cacheWrite` sum to `totalTokens`, and `reasoning` is an informational subset of `output`. Pi prices billed operations in `usage.cost.total`, so Session Detail uses their summed reported cost instead of splitting the session subtotal; a provider that reports no price falls back to that split.

## Invariants and known gaps

- **`reasoning` is never added to the total.** It is a subset of `output`; `totalTokens` is `input + output + cacheRead + cacheWrite`. Adding it would double-count.
- **The session id is a filename suffix**, so the basename walk used for other clients cannot find a Pi transcript.
- Session titles and timestamps for Pi are not read here yet; the scan supplies what the Sessions list shows.
- **The bundled scanner still counts only assistant message usage.** Its separate Pi parser needs equivalent operation accounting, deduplication/pricing regression coverage and shared-parser cache invalidation before a separately approved bundle update. This Detail correction does not correct dashboard/history totals. The Detail live signature uses scanner-reported tokens/cost, so an operation-only append may not trigger a re-read while the page stays open; reopening reads the full transcript.

## Verification

```bash
node --test tests/shared/piSessionDetail.test.js tests/shared/sessionFiles.test.js
```
