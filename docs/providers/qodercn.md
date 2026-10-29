---
summary: "Qoder CN token exposure, request credit-to-USD accounting, source discovery and model identities."
ids: [qoder, qodercn]
read_when:
  - Changing or debugging Qoder CN usage, model names or collection roots
  - Touching the fork's token_monitor/qodercn.rs or providers/qodercn/paths.js
---

# Qoder CN usage

Enable **Qoder CN** under **Settings → Collection**. Usage belongs in the existing Models, sessions and history views, in the same units as other clients: measured tokens and estimated USD cost. **AI Tool Limits → Qoder** remains a separately authenticated account-quota feature.

## Enable actual token counts

Qoder CN CLI 1.1.62 masks first-party token counts when serializing transcripts by default. Before starting a new CLI process, enable its native setting:

```bash
export QODERCN_EXPOSE_TOKEN_USAGE=1
qoderclicn
```

The CLI also reads its global `~/.qoder-cn/.env` when no project dotenv takes precedence. Existing CLI processes must restart to load a new setting. A real persisted request with this switch reported 132 input and 18 output tokens, and the native parser returned those exact counts. Already masked historical counters cannot be reconstructed. BYOK/custom-model records containing measured token fields continue to work without this switch.

The token-exposure switch was verified with CLI 1.1.62, not the Desktop app. Desktop JSONL with measured token fields is supported, as is the legacy IDE SQLite source. Masked Desktop counters contribute no tokens; enabling the CLI switch is not a verified Desktop workaround.

JSONL `input_tokens` includes `cache_read_input_tokens`; the parser subtracts that cached subset before emitting uncached input. Credits and context-window occupancy are never converted to tokens.

## Convert request credits to the standard USD cost

The native parser reads finite, nonnegative numeric `message.usage.credits` from assistant records in Qoder CN’s configured JSONL projects root. CLI, Desktop and records without an `entrypoint` use the same per-request field contract. It retains credit-bearing requests even when their token fields are masked, provided they have a stable request, message or envelope ID. `original_credits`, result/session cumulative totals and account-quota deltas are not substitutes for per-request usage.

Desktop credit accounting is covered by synthetic JSONL tests. Real Desktop installation/transcript acceptance has not been performed, so this establishes parser support for that format rather than verified coverage of every Desktop version or mode.

The reference resource-pack price is **¥40 / 1,000 credits**, or **¥0.04 per credit** ([official CN pricing](https://docs.qoder.cn/product-overview/billing-description)). Conversion is:

```text
costUsd = reportedCredits × 0.04 / CNY-per-USD
```

The desktop passes its effective CNY exchange rate (manual override, fetched rate, then built-in 6.8). Standalone collectors use the built-in rate unless `TOKEN_MONITOR_QODER_CN_USD_PER_CREDIT` supplies a positive USD-per-credit rate. FX changes invalidate the pricing anchor and reprice all periods/history when Qoder CN is tracked or the client filter is unrestricted. Collectors that explicitly exclude Qoder CN retain their anchors and History schedule, and the desktop omits the unused credit rate from their runtime configuration. Session-detail pricing revisions are scoped to the requested client, so Qoder CN exchange rates do not invalidate Codex Dots price caches. The source cache retains raw credits, not a frozen USD amount.

This is an estimated resource value, like other model-cost estimates, not the user's cash invoice: subscription discounts and free promotions can differ. `billable: false` does not change the resource unit. The CN price is different from global Qoder and Kiro pricing.

Credit-derived USD enters the ordinary native cost field. It replaces token-catalog estimation for the same request, including explicit zero, so one request is not charged twice. Existing explicit custom pricing keeps its normal precedence. Stable request ids deduplicate copied/resumed transcripts and subagent files before aggregation. Session-scoped message/envelope aliases may link through multiple copies only when the connected group identifies at most one explicit request; conflicting request IDs remain distinct. The latest measured token observation survives newer masked copies, while the latest explicit credit value (including zero) remains authoritative. Missing-session fallbacks stay source-local. Legacy database records retain their existing accounting behavior.

History does not treat equal token totals as proof of complete source coverage: a model can mix measured-token requests with masked, cost-only requests. A smaller same-model request count keeps the more complete archived cost; matching counts still allow explicit zero-credit corrections. A model absent from a later scan retains its observed usage and cost, including live-only history not yet captured by a graph. Absence is not an explicit zero-credit correction. Live single-model sessions provide exact model request counts, including sessions with measured tokens. When a session spans multiple models, its total cannot be assigned to each model: its per-model counts are unknown, not zero. Such live data can update tokens and cost when neither decreases; it cannot lower retained cost. A fresh native graph confirms exact counts and price corrections together. Graph capture, live capture and snapshots passed between collectors use the same model completeness check before selecting a day, so a stale snapshot cannot lower the saved cost while another client's usage grows. Sessions with positive cost remain visible with their known model names even when tokens are masked. Widget model rankings continue to require measured tokens.

Cost-only sessions with positive cost appear in the session list for every tracked client, not only Qoder CN. Cost-only rows remain in snapshot CSV even when no token-map entry exists. macOS Widget model breakdowns continue to list only models with measured tokens; cost-only models are omitted from that token ranking while their USD remains included in the period overview cost. Live History takes model identities from cost maps as well as token maps. An observed native zero-cost request retains its session model key and message evidence, so an explicit zero credit correction survives archive persistence and restart. Empty scans carry no such evidence and retain prior history. Matching cost-only Qoder observations reconcile independently of larger archived usage from other clients; a later native graph scan owns the next source correction.

No separate credits card, model-row style, device wire field or SQLite credit ledger is needed. Existing USD totals, model/client ranking, sessions, archives and DAY/MONTH/TOTAL selections consume the same report as other CLIs.

## Model names

The native display-name table maps `qfmodel` to `Qwen3.8-Flash`, verified against Qoder CN's own `get_models` catalog on 2026-10-15. Internal routing tiers name a tier, not its underlying model. Unknown/custom ids pass through; do not guess a family from an opaque id. Existing model aliases can override a display name if the account catalog changes.

Token Monitor mirrors the same code table app-side in `normalizeTokscaleModelNameForClient` (scoped to the `qodercn` client), so `qfmodel` already shows as `Qwen3.8-Flash` with a vendored tokscale whose table lacks that row. Names the native parser has already mapped pass through unchanged. Stored periods are reconciled on load, including model throughput when client attribution is exclusive. Shared raw model buckets retain period totals but discard ambiguous component, throughput and unpriced-model attribution rather than guessing a split. Collector anchors carry `qoderCnModelVersion: 2`, forcing a full rescan of earlier model/session keys.

Daily History uses the lowercase live model id after this alias mapping for Qoder CN graph rows, archived observations and component summaries. Loading an older archive canonicalizes its model keys too, so native `Qwen3.8-Flash` and live `qwen3.8-flash` refer to the same retained observation. Other clients keep their existing model identities and pricing rules.

For JSONL with a real `sessionId`, the app canonicalizes the native `qodercn:jsonl:<source-hash>:<sessionId>` key to `qodercn:jsonl:session:<sessionId>`. Copying a transcript must not create a second archived conversation. Existing JSON/SQLite archive aliases replay one latest whole snapshot per period, including explicit zero; live report rows still aggregate by conversation. Missing/`unknown` session IDs and legacy database keys remain source-local.

## Sources and recovery

The pinned `Javis603/tokscale` fork parses Qoder CN; upstream tokscale does not yet provide this client. The JSONL projects root resolves in this order:

1. `TOKEN_MONITOR_QODER_CN_PROJECTS_PATH`;
2. `QODERCN_CONFIG_DIR/projects`;
3. `~/.qoder-cn/projects`.

Legacy SQLite usage comes from `SharedClientCache/cache/db/local.db` under the platform's QoderCN application-data root, or `TOKEN_MONITOR_QODER_CN_DB_PATH`. The two storage generations have no verified cross-format request identity and remain separate sources. JSONL workspaces use `cwd`; legacy bare project names do not establish a filesystem project.

Source fingerprints and normalized rows are cached in `<tokscale cache dir>/token-monitor/qodercn.json`. Missing roots are valid empty sources; read/traversal failures and bounded-read exhaustion serve the last complete source snapshot and emit a warning, rather than silently publishing a partial scan. Changing either configured root invalidates the collector anchor. Records without a usable timestamp fall outside date-filtered windows. Qoder CN remains excluded from WSL scans to avoid recounting the host database.

Local collection needs no credential. The `qoder` limits cookie stays behind its separate credential/transport boundary. A credit ledger left by an earlier local preview is not read or deleted by this implementation.

## Verification

```bash
node --test tests/shared/collectorPricing.test.js tests/shared/collectorAnchorPersistence.test.js tests/shared/clientHealth.test.js
# In Javis603/tokscale:
cargo test --locked -p tokscale-core token_monitor::qodercn
```

The vendor manifest pins the native Qoder CN credits parser build. Keep its published source and platform checksums aligned; a green JavaScript test suite alone does not verify bundled native credits support.
