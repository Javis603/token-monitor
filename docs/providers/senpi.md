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

The native collector reads these transcript layouts through tokscale:

```
~/.omo/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
~/.senpi/agent/sessions/<encoded-cwd>/<timestamp>_<sessionId>.jsonl
~/.omo/agent/projects/<project-key>/senpi-task/children/<task>/sessions/
<project>/.omo/senpi-task/children/<task>/sessions/
```

`SENPI_CODING_AGENT_DIR` replaces the standalone Senpi agent root; `SENPI_CODING_AGENT_SESSION_DIR` adds a sessions directory. OmO selects its agent directory through `OMO_CODING_AGENT_DIR`, then the legacy `SENPI_CODING_AGENT_DIR` / `PI_CODING_AGENT_DIR` aliases, otherwise `~/.omo/agent`. Token Monitor also accepts normalized `customScanPaths.senpi` for relocated agents, sessions directories and directly or deeply nested transcripts. On Windows, native scanning, source checks and Session Detail follow an absolute native `HOME` before the profile directory. Scoped WSL Detail ignores host environment overrides and host custom paths.

The [OmO source at `6f37e91`](https://github.com/code-yeongyu/oh-my-openagent/blob/6f37e91be0ec39a6fa997fcdc7286d3346e010e0/packages/senpi-task/src/store/project-state-directory.ts) derives `<project-key>` from the canonical project basename and the first 12 hex digits of its SHA-256. The collector discovers existing central stores even after their parent transcript disappears, and derives future central paths from session headers. Legacy project-local and home-local task children remain readable alongside central stores.

Project discovery reads the first session-header line, rather than decoding the lossy session-directory name. Default session trees retain their shallow layout; custom roots follow directory links with cycle detection and are limited to 20,000 entries per discovery and 32 directory levels. Select a narrower custom root if those bounds prevent discovery of external task children; tokscale's scan inside each configured root remains recursive. Header reads stop at 8 KiB; malformed or relative `cwd` values are ignored. Up to 4096 successfully parsed headers are cached by file path, modification time, size and file identity. Unchanged headers avoid repeated reads; failed reads or parses are retried, and entries no longer encountered during discovery are evicted.

An absolute `task.state_dir` in `.omo/omo.jsonc` (falling back to `.omo/omo.json`) adds `<state_dir>/children`. Project configuration overrides the home configuration; an empty or relative project `task` block suppresses inheritance. Configuration reads are bounded to 256 KiB.

The pinned tokscale `324d5136` environment-based extra-root scanner does not discover external OmO children itself. The native collector supplies discovered transcript roots through its existing `TOKSCALE_EXTRA_DIRS` transport for both usage and History, sharing one snapshot across Today/Month/All Time. Tokscale owns parsing, pricing and overlapping-file deduplication. Derived roots share that transport's comma/newline restriction. A Senpi source revision invalidates pre-fix persisted anchors on upgrade.

Only transcript roots, configuration files and necessary ancestor chains are admitted to watching. Parent watch ticks refresh discovery so later task children receive their own watcher. The collector never falls back to watching the entire home or filesystem, and unrelated project bookkeeping stays pruned. Polling retains the shared entry budget and interval fallback.

## Accounting

Senpi documents `usage.reasoning` as a subset of `usage.output`. Tokscale parses the field and does not add it to the total. Do not put `senpi` in `TOKSCALE_DISJOINT_REASONING_CLIENTS`: that set is for clients whose JSON `reasoning` bucket is additive.

Session Detail uses the shared Pi-format parser. `reasoningTokens` stays informational. A session resolves by `<sessionId>.jsonl` or the `_<sessionId>.jsonl` suffix under default, discovered and custom roots. Electron supplies normalized saved custom paths to the Detail worker; renderer-supplied paths are ignored. A task child whose file is named for the task rather than the session id is still counted by tokscale, but Detail does not open it.

## Verification

```bash
node --test tests/shared/senpiSources.test.js tests/shared/senpiSessionDetail.test.js tests/shared/clientHealth.test.js tests/shared/usage.test.js
```

## Presentation

App and README labels use **OmO Native**; `senpi` remains the accounting id for both standalone Senpi and OmO Native. The icon represents the OmO product brand, not a separately published Senpi logo.

Artwork comes from the [official OmO light icon](https://github.com/code-yeongyu/oh-my-openagent/blob/6f37e91be0ec39a6fa997fcdc7286d3346e010e0/.github/assets/omo-icon-light.svg). The website SVG and 512px README PNG preserve its light tile and dark mark, trimming only the outer transparent padding. The app removes the tile, trims the viewBox to the mark without stretching it, and uses `currentColor` for CSS masks and tray recoloring. Chart color `#00D4FF` follows the official website's `--accent` in `packages/web/app/styles/design-system.css` at the same revision.
