---
summary: "Z.ai/GLM provider notes: the two-key system, the three quota pools that merge into one row, the ZCode billing gateway's device-id gate, and the local spend store."
read_when:
  - Adding or changing Z.ai quota, balance, or subscription windows
  - Changing ZCode local discovery or the mirror-key credential path
  - Debugging ZCode Start/Weekend plan buckets or the billing endpoint
  - Changing the zai-balance.json spend store or its day-key semantics
  - Changing Z.ai credential handling or security boundaries
---

# Z.ai (GLM) provider

Z.ai appears in Token Monitor as one limits row fed by up to three independent account pools. Quota and cash balance share a console key; ZCode plan grants use the locally discovered credential. Their responses are combined at the row, with usable data retained when another request fails.

| Pool | Credential | Endpoint | Windows |
| --- | --- | --- | --- |
| Subscription quota | Console API key (manual / env) | `{z.ai\|bigmodel}/api/monitor/usage/quota/limit` | `session`/`weekly`, MCP `billing` |
| Cash balance | Console API key | `{host}/api/biz/account/query-customer-account-report` | `credits` |
| ZCode Start/Weekend plans | ZCode on-disk mirror JWT | `zcode.z.ai/api/v1/zcode-plan/billing/balance` | model-aggregated `daily`/`billing` with `limitId` |

## Two keys, two chains, never mixed

- The **console key** (`sk-…` or `{id}.{secret}`) calls quota, subscription, and the finance report. It cannot call the ZCode billing endpoint.
- A **start-plan mirror JWT** calls billing. A **coding-plan mirror key** calls quota. These are different selections and credentials, not one JWT that is assumed to work on both endpoints. Discovery reads the selected provider's `options.apiKey` in `config.json`; it never decrypts `credentials.json` or reads the OS keychain. The mirror remains in memory and never enters Token Monitor's credential store or renderer.
- Billing auth failures surface as `unavailable` until ZCode refreshes its managed credential. A console quota 401/403 surfaces as `unauthorized`. Do not infer endpoint compatibility from a key's format.

## ZCode billing gateway gates

`billing/balance` hard-requires `X-Device-Mid`, read from `~/.zcode/v2/telemetry-state.json`; without it the gateway answers HTTP 400 `code:3001 parameter error`. `app_version` and the other source headers ZCode itself sends are not validated — do not add them. ZCode dedups concurrent identical billing requests behind an in-flight cache; our refresh cadence makes that unnecessary.

## Pool semantics

- Quota and finance run concurrently. Subscription lookup enriches only a quota response with usable windows; failed or empty quota never starts that extra request. A successful finance response still contributes Balance and Spend when quota fails.
- Console quota transport failures retain their classified status (`unauthorized`, `sourceRateLimited`, or `unavailable`), even when other data survives. A failed ZCode request also degrades status while preserving console data; console quota errors take precedence. Finance and subscription enrichment remain best-effort and do not erase usable quota.
- A successful no-plan response (`code:500`, no quota windows) with a valid cash balance is `ok`; without usable data an attempted lane is `unavailable`. An entitled but empty ZCode balance response likewise yields `unavailable` when it is the only source.
- The same console key and ZCode coding-plan key at the same regional endpoint query and render quota once.
- A coding-plan selection also queries billing in parallel and renders the account's Start/Weekend buckets in the same row (ZCode does the same via `validateZaiCodingPlanPairAvailability`); billing is best-effort and never blocks the quota answer. The row header names the consumed mode; the buckets are the account's assets. Different credentials are not assumed to be the same account. A manual key controls the console lane; an independent Start/Weekend billing lane can still contribute.
- All quota/billing windows are live HTTPS responses. They omit component `source: local`; only the credential was found on disk. Provider-level source remains `api` with a console key and `oauth` for discovery alone.

## Model aggregation

Start Plan and Weekend token grants with the same returned model name (`show_name`, trimmed and case folded) are summed. There is no model-version table, model-name whitelist, or separate rule for future versions. `capabilities`, `meter`, and `unit_type` are not grouping keys: internal capability ids can differ and balance buckets can omit the optional unit metadata while the returned model name is the same. Different model names stay separate. Missing names or incomplete quantities stay separate; unknown models with valid names and quantities are accepted automatically.

Totals and remaining units are summed, with missing used/remaining derived from the available pair. The aggregate's used percentage is `sum(used) / sum(total)`, not the mean of percentages. For example, a 300M Weekend Flash bucket plus a 5M daily Flash bucket yields one 305M pool. This is currently granted capacity, not a daily allowance or an inference-token count; the quota endpoint's subscription windows are not added to it.

The account header prefers an active plan with daily entitlements and uses plan identity as a deterministic tie-breaker. The model pool can span plans regardless of that header.

Only daily pools with one common boundary carry `windowMinutes: 1440`. Every pool carries `resetsAt` — the earliest component boundary retained for compatibility and scheduling — so the reset scheduler re-probes right after it and burn-rate re-baselines when it rolls. `boundaryKind` marks that earliest change as `reset`, `expiry`, or `mixed`; the shared presentation therefore renders `Reset`, `Expires`, or the simultaneous form without provider-specific wording. Refresh recomputes the available pool after a component expires or renews. This compact representation exposes the earliest known change, not a full component schedule.

Plan and daily windows print their absolute token pair (`124M / 305M`, remaining or used per the shared setting) through the existing detail slot — the same rule Command Code credits follow. Single buckets retain their plan id in `limitId`; combined models use a deterministic `zcode-model:` hash of the model-name identity, and missing plan ids receive a `zcode-bucket:` fallback. All remain ordinary existing wire fields. The full Limits page pairs quota/model windows, widens an odd final quota, then appends every MCP/legacy unmarked billing window full width, followed by Balance and Spend. Home keeps model names for daily windows; Home/widget surfaces retain their existing window caps. The native widget snapshot still omits model labels and custom reset descriptions, and the tray still selects a quota according to its existing mode; neither surface is a full per-model list.

## Spend store

The spend store is `zai-balance.json` under the app-data directory that `sharedDataDir()` resolves (`~/Library/Application Support/Token Monitor` on macOS, `%APPDATA%\Token Monitor` on Windows, `$XDG_CONFIG_HOME/Token Monitor` elsewhere). It tracks the finance report's cumulative `totalSpendAmount`. Consumption is the positive delta between observations; a drop (refund, plan reset) moves the baseline only. Day keys are local-time. Two non-throwing traps live here: `config.readJson` returns `null` on ENOENT (a null check, not just try/catch, makes a fresh store), and `Number(null) === 0` is finite — the missing-total guard must check for `null` before `isFinite` or a single report without the field rebases the tracked total to zero.

Loaded spend entries normalize a missing, null, array or primitive `dailySpend` to an object and persist the repair even if the cumulative total has not changed. Invalid store/account container shapes reinitialize safely. A failed write is best-effort. The store remains a device-local read-modify-write file: concurrent writers can lose history; it is not an atomic transaction or guaranteed self-healing after races.
