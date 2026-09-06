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

Z.ai appears in Token Monitor as one limits row fed by up to three independent account pools. The pools have separate credentials, separate endpoints, and separate failure modes; they merge only at the row.

| Pool | Credential | Endpoint | Windows |
| --- | --- | --- | --- |
| Subscription quota | Console API key (manual / env) | `{z.ai\|bigmodel}/api/monitor/usage/quota/limit` | `session`/`weekly`, MCP `billing` |
| Cash balance | Console API key | `{host}/api/biz/account/query-customer-account-report` | `credits` |
| ZCode Start/Weekend plans | ZCode on-disk mirror JWT | `zcode.z.ai/api/v1/zcode-plan/billing/balance` | per-model `daily`/`billing` with `limitId` |

## Two keys, two chains, never mixed

- The **console key** (`sk-…` or `{id}.{secret}`) calls quota, subscription, and the finance report. It cannot call the ZCode billing endpoint.
- The **ZCode JWT** calls the billing endpoint — and, for a coding-plan login, the quota endpoint too, because ZCode mirrors a quota-capable key into the provider entry. A **start-plan** JWT cannot call quota (401), so the chains stay separate per plan kind, not per key format. ZCode stores its login token AES-GCM-encrypted in `~/.zcode/v2/credentials.json` (unreadable to us); the only usable copy is the plain JWT mirrored into `config.json`'s provider entry (`options.apiKey`), which ZCode rotates on each login. A stale mirror is answered by the server as an auth error and surfaces as `unavailable` until ZCode refreshes — mirroring ZCode's own `classifyAvailabilityError`, which maps billing 401/403 to unavailable, not to a user-fixable auth failure.
- Swapping a start-plan JWT into the quota endpoint, or a console key into billing, returns 401. This is not a bug to fix; the chains are separate by design.

## ZCode billing gateway gates

`billing/balance` hard-requires `X-Device-Mid`, read from `~/.zcode/v2/telemetry-state.json`; without it the gateway answers HTTP 400 `code:3001 parameter error`. `app_version` and the other source headers ZCode itself sends are not validated — do not add them. ZCode dedups concurrent identical billing requests behind an in-flight cache; our refresh cadence makes that unnecessary.

## Pool semantics

- An empty pool is absent, not zero: a pool only contributes windows when it actually has something.
- A quota answer of `200 + code:500 "当前用户不存在coding plan"` means "no subscription under that key" — the row reads `unavailable`, not `notConfigured`.
- An entitled plan with empty `balances` is a legal mid-state (grant not yet effective): the lane still counts as attempted, so the row reads `unavailable` rather than contradicting the detected-login pill with "not configured".
- ZCode reuses the start-plan slot for Weekend Build (`plan_id` like `zcode-v3-start-plan-wk-0906` — it contains "start-plan"). Do not branch on plan kind; map whatever buckets billing returns. `one_time` grants carry `resetDescription: "One-time"` and never renew.
- The current-plan label mirrors ZCode's `pickCurrentZaiStartPlan`: the first `status:"active"` plan whose `plan_id` or `name` carries the start-plan identity. Neither side sorts by `plan_priority`; payload order is server-controlled.

## Spend store

The spend store is `zai-balance.json` under the app-data directory that `sharedDataDir()` resolves (`~/Library/Application Support/Token Monitor` on macOS, `%APPDATA%\Token Monitor` on Windows, `$XDG_CONFIG_HOME/Token Monitor` elsewhere). It tracks the finance report's cumulative `totalSpendAmount`. Consumption is the positive delta between observations; a drop (refund, plan reset) moves the baseline only. Day keys are local-time. Two non-throwing traps live here: `config.readJson` returns `null` on ENOENT (a null check, not just try/catch, makes a fresh store), and `Number(null) === 0` is finite — the missing-total guard must check for `null` before `isFinite` or a single report without the field rebases the tracked total to zero.
