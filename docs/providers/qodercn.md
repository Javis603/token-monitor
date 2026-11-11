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

Qoder local usage and account quotas have separate registrations:

| Id | Role | Unit |
| --- | --- | --- |
| `qoder` | opt-in tracked client for international Qoder CLI/IDE transcripts | tokens and estimated API cost |
| `qodercn` | opt-in tracked client for local Qoder CN usage | tokens and estimated API cost |
| `qoder` (limits catalog) | AI Tool Limits provider for global or CN accounts | big-model credits |

Credits are quota units, not tokens. Never copy credit deltas into `qodercn` usage rows or token history.

## Data sources

| Data | Source |
| --- | --- |
| International Qoder CLI/IDE token usage | JSONL transcripts under `QODER_CONFIG_DIR/projects`, falling back to `~/.qoder/projects` |
| Current Qoder CN token usage | Claude-compatible JSONL transcripts under the configured `projects` directory |
| Legacy Qoder CN token usage | `SharedClientCache/cache/db/local.db` under the platform QoderCN app-data root |
| Credit quota and plan | Qoder's global or CN web API, authenticated with the separately configured `qoder` cookie |
| Shared organization credits | `/api/v1/me/organization-shared-usages/big_model_credits` on the same origin and cookie; only `shared_quota` is this member's cap, while `organization_pool` is the whole team's pool |

Both transcript lanes share upstream Tokscale's Qoder parser for streaming fragment assembly, request deduplication, runtime model changes, subagent labels and timing. Token Monitor's fork keeps international `qoder` roots separate from `qodercn`; enabling either never implicitly scans the other. International usage follows `QODER_CONFIG_DIR/projects`, falling back to `~/.qoder/projects`. The CN compatibility adapter retains the legacy SQLite reader, bounded source reads, last-complete-read fallback and released path-qualified session ids. Its JSONL parser is no longer a separate implementation.

CN JSONL `input_tokens` includes `cache_read_input_tokens`, so the adapter subtracts the cached subset before emitting uncached input. International transcripts use upstream's separate input/cache buckets. Gemini-style `promptTokenCount` includes `cachedContentTokenCount` in both lanes and is split once. Reported reasoning contributes to generated output and total tokens. Dynamic slots such as `dfmodel`, `gfmodel` and `qfmodel` stay as recorded instead of guessing the model behind a changing slot. The separately configured account quota provider is unchanged.

Only rows with reported token counts enter usage. Current first-party, plan-billed rows can contain `credits` and `context_usage_ratio` while every token field is zero. The active context-window denominator is not reliably present in the observed session data and can vary per session, so a model-wide window must not be used to reconstruct tokens. The fork disables upstream character-count estimates for both Qoder lanes. Those rows remain absent from token totals; their credits belong to AI Tool Limits. BYOK/custom-model rows that contain measured token fields are counted normally.

## Source precedence

The CN JSONL projects directory resolves in this order:

1. `TOKEN_MONITOR_QODER_CN_PROJECTS_PATH`;
2. Qoder's own `QODERCN_CONFIG_DIR/projects`;
3. `~/.qoder-cn/projects`.

The legacy database uses `TOKEN_MONITOR_QODER_CN_DB_PATH` when set, then the platform default documented in the README. `src/shared/providers/qodercn/paths.js` resolves the same paths for watching, source health and the anchor fingerprint; it must stay in step with the fork's resolution.

A missing JSONL root is a valid empty source for a legacy-only install. Each source (the database and each transcript) is fingerprinted and its normalized rows are cached in `<tokscale cache dir>/token-monitor/qodercn.json`. Once traversal starts, directory, stat or stream failures, and the file, byte, row and line budgets, fail that whole source: the fork serves its last cached rows and logs a warning rather than publishing a partial read, and a database that is locked or unreadable is treated the same way. Do not skip an unreadable enumerated entry and publish the remaining rows as complete; a scan that returned less would feed a negative delta into the anchored watch tick.

The database path and projects directory are both part of the persisted-anchor fingerprint. Moving either source invalidates the anchor instead of combining today's data from one location with older periods captured from another.

## Credentials and transport

Local token usage needs no credential and stays on disk. The `qoder` limits provider stores its cookie through the shared credential boundary and uses the injected transport for the selected global or CN origin. The local `qodercn` client and the remote `qoder` account do not authenticate or identify each other.

## Invariants and known gaps

- Token history and credit quota remain separate units and surfaces.
- A shared-endpoint 401 may update personal credits, but must retain last-good team credits as stale. A successful shared response must contain a valid member quota; missing or invalid data is unavailable, while an explicit zero allowance can clear the team window.
- A member's shared add-on credits come from the separate organization-shared-usages endpoint; never add `organization_pool`, which belongs to the whole team. Personal and team allowances are separate billing windows (`Credits` and `Team credits`) so either can be hidden independently; a zero-limit allowance is omitted, and team credits without their own reset use the plan's `next_refresh_date` rather than the expired personal `next_reset_at`.
- JSONL zero-token rows are not measured zero usage; they are uncountable with the currently persisted data.
- CN JSONL reads are bounded and fail closed after source discovery begins.
- The explicit Token Monitor projects override takes precedence over Qoder's config-root override.
- Output tokens cannot be recovered from credits or context occupancy.
- Legacy database sessions carry only `chat_session.project_name`, a bare name rather than a path, and project attribution needs a resolved workspace path, so those sessions have no project. JSONL sessions use the transcript `cwd`.
- Legacy database rows without a timestamp stay at the epoch; transcript parsing uses upstream timestamp fallbacks.
- Qoder CN is excluded from WSL scans: under a Windows host the fork resolves the legacy database from the host's `APPDATA`, not from `--home`, so a WSL scan would recount host usage.
- The two storage generations have no verified cross-format message key; do not invent one from path or timestamp similarity.

## Verification

Run:

```bash
node --test tests/shared/collectorAnchorPersistence.test.js tests/shared/anchorSeed.test.js tests/shared/clientHealth.test.js tests/shared/wslUsage.test.js
```

The shared parser and CN compatibility tests live in the fork: `cargo test -p tokscale-core qoder`.

Real first-party Qoder CN installs are still needed to verify whether a future build begins persisting a trustworthy per-session active context window. Do not enable reconstruction from a model catalog or preference default alone.
