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
| ZCode Start/Weekend plans | ZCode on-disk mirror JWT | `zcode.z.ai/api/v1/zcode-plan/billing/balance` | per-model `daily`/`billing` with `limitId` |

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
- The same console key and ZCode coding-plan key at the same regional endpoint query and render quota once. Different credentials are not assumed to be the same account. A manual key controls the console lane; an independent Start/Weekend billing lane can still contribute.
- All quota/billing windows are live HTTPS responses. They omit component `source: local`; only the credential was found on disk. Provider-level source remains `api` with a console key and `oauth` for discovery alone.

## Spend store

The spend store is `zai-balance.json` under the app-data directory that `sharedDataDir()` resolves (`~/Library/Application Support/Token Monitor` on macOS, `%APPDATA%\Token Monitor` on Windows, `$XDG_CONFIG_HOME/Token Monitor` elsewhere). It tracks the finance report's cumulative `totalSpendAmount`. Consumption is the positive delta between observations; a drop (refund, plan reset) moves the baseline only. Day keys are local-time. Two non-throwing traps live here: `config.readJson` returns `null` on ENOENT (a null check, not just try/catch, makes a fresh store), and `Number(null) === 0` is finite — the missing-total guard must check for `null` before `isFinite` or a single report without the field rebases the tracked total to zero.

Loaded spend entries normalize a missing, null, array or primitive `dailySpend` to an object and persist the repair even if the cumulative total has not changed. Invalid store/account container shapes reinitialize safely. A failed write is best-effort. The store remains a device-local read-modify-write file: concurrent writers can lose history; it is not an atomic transaction or guaranteed self-healing after races.
