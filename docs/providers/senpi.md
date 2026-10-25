---
summary: "OmO Native (Senpi) usage comes from tokscale's senpi client; reasoning is already inside output."
ids: [senpi]
read_when:
  - Changing Senpi source roots, session lookup, or token accounting
  - Touching providers/senpi/paths.js or the senpi branch in sessionFiles.js
---

# OmO Native provider

`senpi` is the tracked-client id. Tokscale's display name is "Senpi (OmO Native)". Token Monitor labels the row OmO Native and groups local session records from both standalone Senpi and OmO Native under it. It is not Oh My Pi (`omp`, `~/.omp`) and it was never folded into `pi`, so there is no identity split. A fresh install tracks it. An existing saved Tools selection does not gain `senpi` on upgrade; enable OmO Native in Settings → tools.

| Data plane | Read by | Source |
| --- | --- | --- |
| Token usage | the shared usage collector, through `tokscale --client senpi` | Senpi JSONL, parsed by tokscale's Pi-format parser with the `senpi` client id |
| Session Detail | `sessionDetail.js` via `providers/senpi/paths.js`, on demand | the same transcripts, parsed locally |

## Where the data lives

Tokscale always scans `~/.omo/agent/sessions`. It also scans `~/.senpi/agent/sessions` when `SENPI_CODING_AGENT_DIR` is unset or blank, plus task children:

```
~/.omo/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
~/.senpi/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
~/.omo/senpi-task/children/<task>/sessions/
```

`SENPI_CODING_AGENT_DIR` replaces only the `~/.senpi/agent` root. `SENPI_CODING_AGENT_SESSION_DIR` adds one extra sessions directory. OmO itself has no environment variable for a relocated tree; tokscale reads that from `scanner.extraScanPaths.senpi` in its settings.json. On Windows, the scanner, source checks and native Session Detail use an absolute native `HOME` before the profile directory; scoped WSL lookups ignore host environment overrides.

Task children also live under each project's `.omo/senpi-task/children`. The collector discovers projects from the first session-header line in the selected sessions trees and configured custom scan roots. It checks every header in each per-project directory because the encoded directory name is lossy and can represent multiple projects. Header reads stop at 8 KiB; malformed or relative `cwd` values are ignored. A process-local cache retains up to 4096 successfully parsed headers, keyed by file path, modification time, size and file identity. Unchanged headers avoid repeated reads; failed reads or parses are retried, and entries no longer encountered during discovery are evicted. Directory timestamps are not used for invalidation.

An absolute `task.state_dir` in `.omo/omo.jsonc` (falling back to `.omo/omo.json`) relocates children to `<state_dir>/children`. Project configuration overrides the home configuration; a project declaring an empty or relative `task` block restores that project's default layout instead of inheriting the home block. Configuration reads are bounded to 256 KiB, so an oversized file waits for interval collection through tokscale.

Only transcript roots, configuration files and their necessary ancestor chain are admitted to the watcher. An existing project can therefore discover children created after startup without watching its dependencies or unrelated `.omo` caches. Watch ticks re-evaluate these roots as well as full ticks. An installation with no existing source ancestor below home relies on the next interval for discovery; the collector never watches the entire home or filesystem as a fallback. Polling retains the shared entry budget and interval fallback.

## Accounting

Senpi documents `usage.reasoning` as a subset of `usage.output`. Tokscale parses the field and does not add it to the total. Do not put `senpi` in `TOKSCALE_DISJOINT_REASONING_CLIENTS`: that set is for clients whose JSON `reasoning` bucket is additive.

Session Detail uses the shared Pi-format parser. `reasoningTokens` stays informational. A main session resolves by the `_<sessionId>.jsonl` suffix under the scan roots. A task child whose file is named for the task rather than the session id is still counted by tokscale, but Detail does not open it.

## Verification

```bash
node --test tests/shared/senpiSources.test.js tests/shared/senpiSessionDetail.test.js tests/shared/clientHealth.test.js tests/shared/usage.test.js
```

## Presentation

App and README labels use **OmO Native**; `senpi` remains the accounting id for both standalone Senpi and OmO Native. The icon represents the OmO product brand, not a separately published Senpi logo.

Artwork comes from the [official OmO light icon](https://github.com/code-yeongyu/oh-my-openagent/blob/6f37e91be0ec39a6fa997fcdc7286d3346e010e0/.github/assets/omo-icon-light.svg). The website SVG and 512px README PNG preserve its light tile and dark mark, trimming only the outer transparent padding. The app removes the tile, trims the viewBox to the mark without stretching it, and uses `currentColor` for CSS masks and tray recoloring. Chart color `#00D4FF` follows the official website's `--accent` in `packages/web/app/styles/design-system.css` at the same revision.
