---
summary: "Zed provider notes: local token tracking, dashboard quotas, browser-cookie credentials, and platform boundaries."
read_when:
  - Adding or changing Zed token or session tracking
  - Changing Zed dashboard billing endpoints or Cookie setup
  - Debugging Zed plan, token-spend, or reset display
  - Changing Zed credentials, headless configuration, or security boundaries
---

# Zed provider

Zed appears in Token Monitor in two independent data planes. Keep them separate when changing or debugging the provider.

| Data plane | What it measures | Primary runtime | Inputs |
| --- | --- | --- | --- |
| Token/session activity | Local model-token activity attributed to Zed | Shared usage collector through `tokscale` | Local Zed conversation data |
| Limits/billing | Zed-hosted token spend, included spend limit, plan, reset, and Edit Predictions entitlement | Shared limits runtime | A manually supplied Zed dashboard `Cookie` header |

A dashboard Cookie is not a token-history source. Likewise, finding local Zed sessions does not authenticate the dashboard billing endpoints.

## Token and session activity

`src/shared/collector.js` is the only runtime that invokes `tokscale`. Zed follows the same today/month/all-time usage pipeline, watch behavior, and platform discovery rules as the other tracked clients. Its normalized client id is `zed`.

This data plane reports activity found on the current machine. It does not infer the Zed account or plan that paid for a request. BYOK models and external agents remain attributable to the provider whose local records and billing relationship produced them.

Changes to dashboard authentication, limits identity, or account aggregation must not alter Zed token attribution.

## Limits and billing

Zed billing collection uses the dashboard's own JSON endpoints:

```text
GET https://cloud.zed.dev/frontend/billing/usage
GET https://cloud.zed.dev/frontend/billing/subscriptions/current
Cookie: zed.session=...; ...
```

The usage request is required. The subscription request is optional plan and account-identity enrichment: a failure there must not hide valid spend data that the usage endpoint already returned.

The Zed editor's native credential and `GET /client/users/me` are deliberately not used for limits. That account response exposes plan, Edit Predictions, and a subscription period, but not the dashboard's token-spend allowance. The same native credential is rejected by the dashboard billing endpoint, so combining the two would create a second sign-in flow without authenticating the data Token Monitor intends to show.

The dashboard response is authoritative for both Token Spend and Edit Predictions. Token Monitor reads `current_usage.edit_predictions` directly instead of inferring entitlement from a plan name: a null `limit` is shown as Unlimited without a meter, a positive `limit` is shown with the returned usage, and a missing or malformed field is omitted. This matters for organization Billing Managers, who can see Business billing data without receiving the Business AI entitlement.

## Credential and security boundary

The widget asks the user to copy the request-header `Cookie` value from a signed-in `frontend/billing/usage` browser request. It does not read browser databases, browser storage, macOS Keychain, Windows Credential Manager, or Linux Secret Service.

The normalized credential must contain `zed.session`. Token Monitor forwards only the observed Zed billing cookies (`zed.session`, `c15t`, and supported Cloudflare helpers) to `cloud.zed.dev`; unrelated cookies from the copied header are discarded. Provider requests use `credentials: 'omit'` so Electron's ambient cookie jar cannot replace the explicitly managed credential.

GUI credentials live under the fixed `zedCookie` path in the shared credential store. The renderer receives only configured/source markers, never the stored Cookie value. Headless installations can set `TOKEN_MONITOR_ZED_COOKIE` (or the compatibility alias `ZED_COOKIE`).

## Snapshot mapping

| Zed field | Token Monitor output |
| --- | --- |
| `plan` | Plan label, with transport prefixes such as `token_based_` removed |
| `current_usage.token_spend_in_cents` | Token Spend used amount |
| `current_usage.token_spend.spend_in_cents` | Fallback Token Spend used amount |
| `current_usage.token_spend.limit_in_cents` | Token Spend limit |
| `current_usage.token_spend.updated_at` | Upstream payload timestamp for diagnostics |
| `current_usage.edit_predictions.used` | Accepted Edit Predictions used |
| `current_usage.edit_predictions.limit` | Edit Predictions limit; `null` means Unlimited |
| `current_usage.edit_predictions.remaining` | Accepted Edit Predictions remaining when metered |
| `subscription.name` | Preferred plan label when available |
| `subscription.period.end_at` | Token Spend reset timestamp |

Spend values are converted from cents to USD. `zed.token-spend` is the measured billing window and appears first, matching Zed's dashboard; its reset uses the subscription period end while omitting the separate renewal-date copy owned by Token Monitor's subscription feature. `zed.edit-predictions` follows only when the usage response supplies a valid quota object and does not inherit that reset.

## Identity and aggregation

The required `zed.session` cookie always seeds the hashed `accountKey`, so optional subscription enrichment cannot change provider identity when it times out or fails. Raw credential material never enters the wire record; subscription metadata only enriches the plan label and Token Spend reset.

The key can change when the browser session rotates. That is acceptable for the single-cookie settings model, but a future multi-account implementation must obtain a stable dashboard account identifier before promising cross-device deduplication.

## Platform behavior

Manual Cookie setup and the shared outbound fetch path are platform-independent. There is no macOS-only or Windows-only credential lookup and no dependency on a locally installed Zed editor for limits refresh.

Token/session tracking still depends on local Zed data that `tokscale` supports on that platform. A configured dashboard Cookie does not make missing local activity available.

## Change map

| Concern | Primary files |
| --- | --- |
| Token/session source discovery and collection | `src/shared/collector.js`, `src/shared/clientTracking.js`, `src/shared/usage.js` |
| Dashboard Cookie parsing and billing requests | `src/shared/zedLimits.js`, `src/shared/limitCollector.js` |
| Credential persistence and runtime configuration | `src/shared/credentialStore.js`, `src/electron/runtimeConfig.js`, `src/electron/main.js` |
| Settings flow and localized setup instructions | `src/electron/renderer/index.html`, `src/electron/renderer/app.js`, `src/electron/renderer/i18n.js` |
| Limits presentation | `src/electron/renderer/limitProviderPresentation.js`, `src/electron/renderer/app.js`, `src/shared/macWidgetSnapshot.js` |
| Hub build identity after shared changes | `src/shared/hubBuildRegistry.json`, generated Worker registry |

## Verification checklist

- Cookie normalization rejects headers without `zed.session` and strips unrelated cookies.
- Usage success remains visible when the optional subscription request fails.
- `401`/`403`, `429`, timeouts, malformed payloads, and aborted probes map to the shared provider statuses.
- Spend cents map to the correct USD used, limit, remaining, and percentage values.
- Edit Predictions comes only from `current_usage.edit_predictions`: null limits render as Unlimited without a meter, positive limits preserve measured usage, and missing fields stay absent regardless of plan name.
- Subscription data can enrich the plan and stable account identity without adding renewal copy to Token Spend.
- Settings never echo the stored Cookie to the renderer.
- A credential change invalidates only the Zed limits lane.
- The Open Zed button is restricted to the approved dashboard host.
- Token/session collection remains unchanged.

Run focused tests while iterating, then finish with `npm run sync:worker` when generated shared Worker files changed, `npm run verify`, and `git diff --check`.
