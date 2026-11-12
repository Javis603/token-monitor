---
summary: "Qoder provider notes: separate credits and token planes, JSONL source precedence, bounded reads, cache migration and first-party token gaps."
ids: [qoder, qodercn]
read_when:
  - Changing or debugging Qoder or Qoder CN usage, limits, source discovery or storage migration
  - Investigating Qoder CN usage that is missing, zero or stale in the widget
  - Touching the fork's token_monitor/qodercn.rs, Qoder roots in clientSources.js
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
| Credit quota and plan | Qoder's global or CN web API, authenticated with the separately configured `qoder` cookie |
| Shared organization credits | `/api/v1/me/organization-shared-usages/big_model_credits` on the same origin and cookie; only `shared_quota` is this member's cap, while `organization_pool` is the whole team's pool |

Both transcript lanes share upstream Tokscale's Qoder parser for streaming fragment assembly, request deduplication, runtime model changes, subagent labels and timing. Token Monitor's fork keeps international `qoder` roots separate from `qodercn`; enabling either never implicitly scans the other. International usage follows `QODER_CONFIG_DIR/projects`, falling back to `~/.qoder/projects`. The CN compatibility adapter retains bounded source reads, last-complete-read fallback and released path-qualified session ids. Its JSONL parser is no longer a separate implementation.

CN JSONL `input_tokens` includes `cache_read_input_tokens`, so the adapter subtracts the cached subset before emitting uncached input. International transcripts use upstream's separate input/cache buckets. Gemini-style `promptTokenCount` includes `cachedContentTokenCount` in both lanes and is split once. Reported reasoning contributes to generated output and total tokens. Dynamic slots such as `dfmodel`, `gfmodel` and `qfmodel` stay as recorded instead of guessing the model behind a changing slot. The separately configured account quota provider is unchanged.

Only rows with reported token counts enter usage. Current first-party, plan-billed rows can contain `credits` and `context_usage_ratio` while every token field is zero. The active context-window denominator is not reliably present in the observed session data and can vary per session, so a model-wide window must not be used to reconstruct tokens. The fork disables upstream character-count estimates for both Qoder lanes. Those rows remain absent from token totals; their credits belong to AI Tool Limits. BYOK/custom-model rows that contain measured token fields are counted normally.

## Source precedence

The CN JSONL projects directory resolves in this order:

1. `TOKEN_MONITOR_QODER_CN_PROJECTS_PATH`;
2. Qoder's own `QODERCN_CONFIG_DIR/projects`;
3. `~/.qoder-cn/projects`.

`clientSourceRoots()` resolves the JSONL directory for watching, source health and the anchor fingerprint. Legacy SQLite-only releases are no longer scanned, and `TOKEN_MONITOR_QODER_CN_DB_PATH` is no longer used. SQLite-only usage will no longer enter fresh scan totals; existing Token Monitor archive files are not deleted.

A missing JSONL root is a valid empty source. Each transcript is fingerprinted and its native messages are cached in `<tokscale cache dir>/token-monitor/qodercn-<source-root-id>.json`. Caches are isolated per projects root, including WSL homes. Previous JSONL snapshots in `qodercn.json` are upgraded without changing session identities; retired database snapshots are discarded. Once traversal starts, directory, stat or stream failures, and the file, byte, row and line budgets, fail the whole JSONL source: the fork serves its last complete snapshot instead of publishing a partial read.

The projects directory is part of the persisted-anchor fingerprint. Moving it invalidates the anchor. Anchors that included the retired database source are also invalidated before any watch delta is applied. Explicit `--home` scans ignore host environment overrides, so Qoder CN can be collected from WSL homes without recounting host usage.

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
- JSONL sessions use the transcript `cwd` for project attribution.
- Transcript parsing uses upstream timestamp fallbacks.

## Verification

Run:

```bash
node --test tests/shared/collectorAnchorPersistence.test.js tests/shared/anchorSeed.test.js tests/shared/clientHealth.test.js tests/shared/wslUsage.test.js
```

The shared parser and CN compatibility tests live in the fork: `cargo test -p tokscale-core qoder`.

Real first-party Qoder CN installs are still needed to verify whether a future build begins persisting a trustworthy per-session active context window. Do not enable reconstruction from a model catalog or preference default alone.
