---
summary: "OmO Native (Senpi) usage comes from tokscale's senpi client; reasoning is already inside output."
ids: [senpi]
read_when:
  - Changing Senpi source roots, session lookup, or token accounting
  - Touching providers/senpi/paths.js or the senpi branch in sessionFiles.js
---

# OmO Native provider

`senpi` is the tracked-client id. Tokscale's display name is "Senpi (OmO Native)". Token Monitor labels the row OmO Native. It is not Oh My Pi (`omp`, `~/.omp`) and it was never folded into `pi`, so there is no identity split.

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage | the shared usage collector, through `tokscale --client senpi` | Senpi JSONL, parsed by tokscale's Pi-format parser with the `senpi` client id |
| Session Detail | `sessionDetail.js` via `providers/senpi/paths.js`, on demand | the same transcripts, parsed locally |

## Where the data lives

Tokscale always scans both of these home-relative trees, plus task children:

```
~/.omo/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
~/.senpi/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
~/.omo/senpi-task/children/<task>/sessions/
```

`SENPI_CODING_AGENT_DIR` replaces only the `~/.senpi/agent` root. `SENPI_CODING_AGENT_SESSION_DIR` adds one extra sessions directory. OmO itself has no environment variable for a relocated tree; tokscale reads that from `scanner.extraScanPaths.senpi` in its settings.json. Watch roots follow the same two environment variables and the three home-relative directories. Project-local `.omo/senpi-task` trees are discovered by tokscale from session headers during a scan; they are not a fixed host watch root.

## Accounting

Senpi documents `usage.reasoning` as a subset of `usage.output`. Tokscale parses the field and does not add it to the total. Do not put `senpi` in `TOKSCALE_DISJOINT_REASONING_CLIENTS`: that set is for clients whose JSON `reasoning` bucket is additive.

Session Detail uses the shared Pi-format parser. `reasoningTokens` stays informational. A main session resolves by the `_<sessionId>.jsonl` suffix under the scan roots. A task child whose file is named for the task rather than the session id is still counted by tokscale, but Detail does not open it.

## Verification

```bash
node --test tests/shared/senpiSessionDetail.test.js tests/shared/clientHealth.test.js tests/shared/usage.test.js
```
