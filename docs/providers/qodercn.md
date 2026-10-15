---
summary: "Qoder provider notes: separate credits and token planes, legacy SQLite versus current JSONL sources, source precedence, bounded reads, and first-party token gaps."
ids: [qoder, qodercn]
read_when:
  - Changing or debugging Qoder or Qoder CN usage, limits, source discovery or storage migration
  - Investigating Qoder CN usage that is missing, zero or stale in the widget
  - Touching the fork's token_monitor/qodercn.rs, providers/qodercn/paths.js or Qoder roots in clientSources.js
---

# Qoder provider

## Identity and ids

Qoder has two deliberately separate ids:

| Id | Role | Unit |
| --- | --- | --- |
| `qodercn` | opt-in tracked client for local Qoder CN usage | tokens/API cost, plus independent CLI reported credits |
| `qoder` | AI Tool Limits provider for global or CN accounts | big-model credits |

Credits are quota units, not tokens. Never copy credit deltas into `qodercn` usage rows or token history.

## Data sources

| Data | Source |
| --- | --- |
| Current Qoder CN token usage | Claude-compatible JSONL transcripts under the configured `projects` directory |
| Legacy Qoder CN token usage | `SharedClientCache/cache/db/local.db` under the platform QoderCN app-data root |
| Credit quota and plan | Qoder's global or CN web API, authenticated with the separately configured `qoder` cookie |
| CLI reported credits | `message.usage.credits` on CLI assistant records in the JSONL projects source |

Token Monitor's tokscale fork parses Qoder CN (`crates/tokscale-core/src/token_monitor/qodercn.rs` in Javis603/tokscale); upstream tokscale has no `qodercn` client, so the catalog marks it `forkOnly`. The parser reads both usage layouts because an upgraded machine can retain historical SQLite data while new sessions are written to JSONL. JSONL token semantics differ from Anthropic's envelope: `input_tokens` already includes `cache_read_input_tokens`, so the parser subtracts the cached subset before emitting uncached input. Model display names and routing tiers (`auto`, `ultimate`, …) are normalized there too; routing tiers are never priced from the model catalog.

Only rows with reported token counts enter token usage. Current first-party, plan-billed rows can contain `credits` and `context_usage_ratio` while every token field is zero. The active context-window denominator is not reliably present in the observed session data and can vary per session, so a model-wide window must not be used to reconstruct tokens. Those rows remain absent from token totals. BYOK/custom-model rows that contain measured token fields are counted normally.

## CLI reported credits

Enable **Qoder CN** under **Settings → Collection**. The independent **Qoder CN CLI · Credits** Home module shows the selected period's credits, request count and model breakdown. It follows DAY, MONTH, TOTAL and the existing week/7-day/30-day selections; its order and visibility use Home customization. **AI Tool Limits → Qoder** continues to show the separately authenticated account quota.

`providers/qodercn/credits.js` reads assistant records with `entrypoint: "cli"` and a finite, nonnegative numeric `message.usage.credits`, including explicit zero and `billable: false`. The value is reported usage, not cash charged. `original_credits` is not a substitute; requests without `credits`, desktop records and non-assistant records are excluded. A request identity uses `usage.request_id`, then `message.id`, then the envelope `uuid`. Copies in resumed/forked transcripts and subagent files share that identity. A newer timestamp can revise its amount/model; conflicting values for one identity at the same timestamp fail the scan rather than selecting an arbitrary bill.

The metadata ledger is `<shared data directory>/qodercn-credits.sqlite`, using the project's existing `node:sqlite` runtime. It retains source-root, request identity, timestamp, model and credits. Local calendar-day/model rollups are computed from that ledger, with `allTimeSince` applied to the published view. Replaying after restart, log truncation or compaction does not recount retained requests; source deletion does not erase historical credits. Changing the projects root selects that root's independent ledger partition. Disabling Qoder CN publishes no credits, while retaining the ledger for re-enabling.

The collector reuses the source resolver and existing Qoder watcher. Its per-instance file index skips unchanged content and resumes appended bytes, with prefix/tail checks for source replacement; same-size changes and truncations re-read the file. It retains an incomplete final JSONL line in memory until it can be parsed. Complete corrupt rows, invalid financial metadata, read failures and budget exhaustion roll back the credits scan. The collector publishes a bounded failure code with the previous in-process credits view when available, or an unknown baseline on a first failure; original token collection continues. Home and collection health expose the failure, and the next successful scan clears it. Writes are one SQLite transaction per scan; WAL and a busy timeout serialize concurrent app/agent writers. No conversation content is persisted or synchronized.

Source scans are bounded to 10,000 JSONL files, 50,000 directory entries, 512 MiB read per pass and 16 MiB per line. The portable device field admits 3,660 days and 64 distinct models, with credit/request number bounds documented in [API.md](../API.md#qoder-cn-cli-reported-credits). These limits report a failure rather than publishing a truncated financial total.

## Source precedence

The JSONL projects directory resolves in this order:

1. `TOKEN_MONITOR_QODER_CN_PROJECTS_PATH`;
2. Qoder's own `QODERCN_CONFIG_DIR/projects`;
3. `~/.qoder-cn/projects`.

The legacy database uses `TOKEN_MONITOR_QODER_CN_DB_PATH` when set, then the platform default documented in the README. `src/shared/providers/qodercn/paths.js` resolves the same paths for watching, source health and the anchor fingerprint; it must stay in step with the fork's resolution.

A missing JSONL root is a valid empty source for a legacy-only install. Each source (the database and each transcript) is fingerprinted and its normalized rows are cached in `<tokscale cache dir>/token-monitor/qodercn.json`. Once traversal starts, directory, stat or stream failures, and the file, byte, row and line budgets, fail that whole source: the fork serves its last cached rows and logs a warning rather than publishing a partial read, and a database that is locked or unreadable is treated the same way. Do not skip an unreadable enumerated entry and publish the remaining rows as complete; a scan that returned less would feed a negative delta into the anchored watch tick.

The database path and projects directory are both part of the persisted-anchor fingerprint. Moving either source invalidates the anchor instead of combining today's data from one location with older periods captured from another.

## Credentials and transport

Local token usage needs no credential and stays on disk. The `qoder` limits provider stores its cookie through the shared credential boundary and uses the injected transport for the selected global or CN origin. The local `qodercn` client and the remote `qoder` account do not authenticate or identify each other.

## Invariants and known gaps

- Token history, CLI reported credits and authenticated credit quota remain separate units and surfaces.
- JSONL zero-token rows are not measured zero usage; they are uncountable with the currently persisted data.
- JSONL reads are bounded and fail closed after source discovery begins.
- The explicit Token Monitor projects override takes precedence over Qoder's config-root override.
- Output tokens cannot be recovered from credits or context occupancy.
- Legacy database sessions carry only `chat_session.project_name`, a bare name rather than a path, and project attribution needs a resolved workspace path, so those sessions have no project. JSONL sessions use the transcript `cwd`.
- Rows without a timestamp are stored at the epoch and fall outside any `--since` window.
- Qoder CN is excluded from WSL scans: under a Windows host the fork resolves the legacy database from the host's `APPDATA`, not from `--home`, so a WSL scan would recount host usage.
- The two storage generations have no verified cross-format message key; do not invent one from path or timestamp similarity.

## Verification

Run:

```bash
node --test tests/shared/collectorAnchorPersistence.test.js tests/shared/anchorSeed.test.js tests/shared/clientHealth.test.js tests/shared/wslUsage.test.js
node --test tests/shared/qoderCnCredits.test.js tests/electron/qoderCnCreditsView.test.js tests/worker/qoderCnCredits.test.js
```

The parser's own tests live in the fork: `cargo test -p tokscale-core token_monitor::qodercn`.

Real first-party Qoder CN installs are still needed to verify whether a future build begins persisting a trustworthy per-session active context window. Do not enable reconstruction from a model catalog or preference default alone.
