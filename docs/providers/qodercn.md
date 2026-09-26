---
summary: "Qoder provider notes: separate credits and token planes, legacy SQLite versus current JSONL sources, source precedence, bounded reads, and first-party token gaps."
ids: [qoder, qodercn]
read_when:
  - Changing or debugging Qoder or Qoder CN usage, limits, source discovery or storage migration
  - Investigating Qoder CN usage that is missing, zero or stale in the widget
  - Touching providers/qodercn/usage.js or Qoder roots in clientSources.js
---

# Qoder provider

## Identity and ids

Qoder has two deliberately separate ids:

| Id | Role | Unit |
| --- | --- | --- |
| `qodercn` | opt-in tracked client for local Qoder CN usage | tokens and estimated API cost |
| `qoder` | AI Tool Limits provider for global or CN accounts | big-model credits |

Credits are quota units, not tokens. Never copy credit deltas into `qodercn` usage rows or token history.

## Data sources

| Data | Source |
| --- | --- |
| Current Qoder CN token usage | Claude-compatible JSONL transcripts under the configured `projects` directory |
| Legacy Qoder CN token usage | `SharedClientCache/cache/db/local.db` under the platform QoderCN app-data root |
| Credit quota and plan | Qoder's global or CN web API, authenticated with the separately configured `qoder` cookie |

The local adapter reads both usage layouts because an upgraded machine can retain historical SQLite data while new sessions are written to JSONL. JSONL token semantics differ from Anthropic's envelope: `input_tokens` already includes `cache_read_input_tokens`, so the adapter subtracts the cached subset before emitting uncached input.

Only rows with reported token counts enter usage. Current first-party, plan-billed rows can contain `credits` and `context_usage_ratio` while every token field is zero. The active context-window denominator is not reliably present in the observed session data and can vary per session, so a model-wide window must not be used to reconstruct tokens. Those rows remain absent from token totals; their credits belong to AI Tool Limits. BYOK/custom-model rows that contain measured token fields are counted normally.

## Source precedence

The JSONL projects directory resolves in this order:

1. `TOKEN_MONITOR_QODER_CN_PROJECTS_PATH`;
2. Qoder's own `QODERCN_CONFIG_DIR/projects`;
3. `~/.qoder-cn/projects`.

The legacy database uses `TOKEN_MONITOR_QODER_CN_DB_PATH` when set, then the platform default documented in the README.

A missing JSONL root is a valid empty source for a legacy-only install. Once traversal starts, directory, stat or stream failures abort the whole JSONL collection so the collector can retain its last complete snapshot. File, byte, row and line budgets fail the same way. Do not skip an unreadable enumerated entry and publish the remaining rows as complete.

The database path and projects directory are both part of the persisted-anchor fingerprint. Moving either source invalidates the anchor instead of combining today's data from one location with older periods captured from another.

## Credentials and transport

Local token usage needs no credential and stays on disk. The `qoder` limits provider stores its cookie through the shared credential boundary and uses the injected transport for the selected global or CN origin. The local `qodercn` client and the remote `qoder` account do not authenticate or identify each other.

## Invariants and known gaps

- Token history and credit quota remain separate units and surfaces.
- JSONL zero-token rows are not measured zero usage; they are uncountable with the currently persisted data.
- JSONL reads are bounded and fail closed after source discovery begins.
- The explicit Token Monitor projects override takes precedence over Qoder's config-root override.
- Output tokens cannot be recovered from credits or context occupancy.
- The two storage generations have no verified cross-format message key; do not invent one from path or timestamp similarity.

## Verification

Run:

```bash
node --test tests/shared/qoderCnUsage.test.js tests/shared/collectorAnchorPersistence.test.js tests/shared/anchorSeed.test.js tests/shared/clientHealth.test.js
```

Real first-party Qoder CN installs are still needed to verify whether a future build begins persisting a trustworthy per-session active context window. Do not enable reconstruction from a model catalog or preference default alone.
