---
summary: "Oh My Pi provider notes: Tokscale supplies usage totals while Session Detail reads OMP's local Pi-format transcripts."
ids: [omp]
read_when:
  - Changing or debugging OMP Session Detail
  - Touching providers/omp/*.js or the OMP branch in sessionFiles.js/sessionDetail.js
---

# Oh My Pi provider

OMP usage totals come from tokscale. Session Detail reads the local transcript on demand; these data planes stay separate, and each OMP session—including a sub-agent session—remains its own row.

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage (periods, dashboard, history) | the shared usage collector, through `tokscale` | OMP session transcripts, parsed by tokscale |
| Session Detail (per-turn breakdown, prompts) | `sessionDetail.js` with `providers/omp/paths.js`, on demand | the same transcripts, parsed locally |

## Where the data lives

Tokscale scans the fixed home-relative `~/.omp/agent/sessions` root. Main sessions are stored under a bucket directory:

```
~/.omp/agent/sessions/<bucket>/<ISO-timestamp>_<sessionId>.jsonl
```

The first line is a fixed-size `title` slot; the `session` header follows it and carries the session `id`. Sub-agent transcripts can be nested under a parent session directory and named for the task rather than the session:

```
~/.omp/agent/sessions/<bucket>/<timestamp>_<parentId>/<task-name>.jsonl
```

Tokscale's OMP parser delegates to the Pi parser and uses the header `id` as the session id for both main and sub-agent transcripts. Each transcript is scanned independently; copied assistant history is deduplicated across files, so shared usage need not be assigned to the parent session.

## Session Detail

Main sessions resolve first by the `_<sessionId>.jsonl` filename suffix. If that misses, Session Detail recursively scans candidate `.jsonl` files at depth two or deeper and checks their bounded header records for `type: "session"` and a matching `id`. The title slot is ignored by the shared Pi-format parser; prompts, assistant usage, tool names and per-operation costs follow that parser's behavior. Positive reported `usage.cost.total` values are preferred, with the session cost used as a fallback when no positive reported cost exists.

OMP writes the same conversation format as Pi, but its session root is deliberately fixed at `~/.omp/agent`: Session Detail does not honor `PI_CODING_AGENT_DIR` or `OMP_PROFILE`, matching tokscale's scan root. `reasoningTokens` is accepted as an informational alias for `reasoning`; it is not added to total tokens. `model_usage` is not handled: tokscale does not count it, and its schema is not established here, so including it could make detail totals disagree with the session row.

OMP forks, including `/tan`, can copy assistant history with token usage intact; `/tan` clears inherited monetary costs. Detail retains the full transcript, including copied history and zero-cost turns. These per-turn transcript counters can differ from the Sessions list's deduplicated usage: Tokscale keeps the first copy in scan-path order, so either session can retain a shared record. Detail does not repeat that cross-file allocation or scan other transcripts to reconcile it.

## Invariants and known gaps

- OMP's [title cards](https://github.com/can1357/oh-my-pi/blob/a536558dc21634462c1b2647676953204569779c/packages/coding-agent/src/utils/title-card.ts) store `<icon> <CODE>: <title>` directly in the title, for both generated and `/rename` titles. Electron's shared session-row formatter hides a private-use icon only at that card prefix, retaining the code, body and ordinary emoji. Raw collection, archives, Hub records and title sync retain the original text; do not strip private-use characters in the shared usage normalizer to solve a font-dependent display issue.
- Detail reads one transcript at a time and never folds child transcripts into a parent. Copied history already inside a transcript remains visible; do not sum related Detail views as deduplicated usage.
- Only records understood by the shared Pi-format parser contribute to detail totals; adding other OMP-specific records requires confirming tokscale's accounting first.

## Verification

```bash
node --test tests/shared/ompSessionDetail.test.js tests/shared/sessionFiles.test.js tests/shared/sessionDetailResolver.test.js tests/shared/piSessionDetail.test.js
node --test tests/electron/ompSessionTitle.test.js
```
