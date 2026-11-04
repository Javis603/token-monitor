---
summary: MiniMax independent Code and API lanes, resource units and credential ownership
ids: [minimax]
read_when:
  - Changing MiniMax limits, credentials, account identity, source selection or display
---

# MiniMax

## Sources and resource pools

MiniMax Code OAuth and API keys are independent readings. Each key's billing type selects the Token Plan reader (`token-plan`, the default) or API billing (`api`); `minimaxBillingMode` remains the legacy/environment setting. Code uses the current local login regardless of those choices. Key changes never select or sign out Code. Key prefixes do not override the selected billing type, and Token Plan and API billing never fall back to each other. `MINIMAX_CODING_API_KEY` remains the environment credential for headless/agent runs; it is not shown in settings.

| Lane | Credential | Readings |
| --- | --- | --- |
| Token Plan | API key with `token-plan` selected | Quota authorized by that key, with the existing legacy Coding Plan fallback |
| API | API key with `api` selected | API wallet balance and optional server-reported cash Spend |
| Code | Current local MiniMax Code OAuth login | Code points and applicable Code plan quotas |

M Plan is not a separate lane: its keys use the same subscription quota reader as Token Plan, and `token-plan` selects that reader, not a product generation or a combined allowance. Never add overlapping observations as extra allowance.

The producer of a request, the credential used to observe it, and the resource paying for it are different facts. Never assign cost from the client name, login method or token count.

Code points use `CREDITS`, never CNY/USD. Membership's `op_credit_summary.total_remaining_amount` already combines purchased and gifted points; component balances must not be added again or emitted as independent balances. Plan quotas and the pay-as-you-go cash wallet remain separate pools.

## API keys

Environment credentials remain supported as a fallback, including for headless/agent runs, and are not shown in settings. Legacy and saved API keys take precedence over the environment key. Disabled saved entries still suppress environment fallback; removing the last saved entry restores it. Different credentials may observe the same wallet; never sum their balances or allowances.

## Wallet and Spend

API wallet balance comes from `/account/query_balance.available_amount`, including usable vouchers, rather than `cash_balance` alone. It is one `credits` window in CNY for China or USD for International. Zero and negative balances are valid; a missing or nonnumeric amount is unavailable.

Today, Week, Month and All time Spend are `consume_cash_sum` from `/account/amount` over the console's calendar dates (All time is undated). They are not recharge totals, page-row sums or balance deltas. Spend values are replacement snapshots that use the balance reading's key and region. A failed optional result leaves that figure unknown without invalidating the balance, changing region or selecting another credential.

Code OAuth never queries the API wallet or borrows a saved API key, and its status is independent of API credential failures. Do not automatically merge lane identities or assign API Spend to Code. OAuth and a Token Plan key can observe the same subscription's quota; those are separate observations, not additional allowances.

## OAuth ownership

Discovery follows the [mcode data-directory rules](mcode.md), using `auth/prod/{cn,en}/mcode-public`, and checks China then International independently of the API region setting. Resource requests and delegated renewal use the discovered namespace's region. Each namespace contains one current login, not a managed account list. Each usable (unexpired and authenticated) regional login is read as its own Code account; an unusable login is neither shown nor renewed while another region has a usable one. When no login is usable, discovery selects the first present login.

Select exactly one `workspace_type: 0` personal workspace (ID `0` is valid) and pass it explicitly to membership. Missing or ambiguous personal workspaces are unavailable; never change the official client's default workspace. Identity prefers the workspace's `op_group_id`, then membership's.

Code's plan endpoint reports used percentages, unlike the API-key endpoint's remaining percentages. Status 3 means unlimited. `2062` omits an absent plan, while `1004` requires auth recovery. A transient plan failure keeps fresh points. Plan flags and tiers are entitlement hints, not evidence of payment, renewal or expiry.

Code's `accountLabel` names the product, never the subscription. Its plan name comes from workspace or membership `token_plan_tier` when textual; without a token plan it is membership `plan_name`, or `Free` when that is empty, as in the official client. Pure-digit tiers are combo IDs, and only a matching current-subscription combo ID permits a name from the optional combo lookup. A catalog card alone never establishes the current subscription. Names must not cross namespaces, regions, groups, login epochs or combo IDs. Optional name failures leave the plan cell empty without invalidating quota. API-key plan cells stay empty; `Token Plan` and `Pay-as-you-go` are reader labels, not purchased tiers.

Token Monitor reads the official credential and auth-state files without modifying them. It does not exchange refresh tokens, acquire official locks, retry credential writes or clear the official login.

When the selected lease has expired, or membership/plan rejects it with HTTP 401/403 or business code `1004`, Token Monitor may invoke the installed official CLI once with `provider list --json` for that namespace's data root and region, then reread it. Healthy leases never invoke the CLI, and a missing CLI is never installed or updated automatically. The command initializes the official runtime and may migrate its configuration; it is not a side-effect-free status endpoint. A zero exit code does not establish renewal: require a changed, unexpired access token with the same nonempty login epoch after rereading.

## Account identity and aggregation

Code identity hashes the server's regional group. API-key identity retains its existing key hash. Matching readings select one observation through shared aggregation; amounts are never added across devices. One current Code login can coexist with multiple API keys; multiple managed Code logins are unsupported.

Each CN pay-as-you-go key can independently confirm affiliation with the current CN Code group through `GroupId`; an unsuccessful confirmation leaves the readings separate. A confirmed pair shares an account heading, even when other keys are configured, while retaining independent readings, identities and saved costs. Confirmation survives a billing-type edit or cleared quota reading; a different Code identity cannot inherit it. Affiliation never adds amounts or assigns API Spend to Code. Its peer hash is display-only and is stripped from public stats.

An identified successful Code reading may retire the prior local OAuth identity through shared removal markers. A failed or unidentified read cannot prove logout or create a replacement account, and scoped work for a retired account must not adopt a newly logged-in account.

## Regions and display

Existing stored `apiRegion` pins remain supported. For the legacy/environment lane, `minimaxApiRegion` wins over legacy `minimaxApiHost`, then `TOKEN_MONITOR_MINIMAX_API_REGION`, `MINIMAX_API_REGION` and `MINIMAX_API_HOST`. An unset stored region follows the environment; explicit Auto ignores those pins. The wire keeps `cn`/`en`, distinct from settings' `intl`/`auto`.

For API-key sources, Auto first tries the last region that returned quota windows, or International when none is remembered. A pinned region never crosses regions. HTTP 401/403, business `1004` (including its HTTP 400 form) and transport failures may drive the fallback; ordinary 400 errors, 5xx, 429 and JSON errors do not. Remember a region only after a usable reading.

A healthy Code or API reading keeps the provider summary live; API key status never inherits Code's health. Both Code points and the API wallet use `metric: 'credits'` with their own units. Code points use the shared display-only balance meter; API cash Spend never supplies its denominator, and display estimates never enter the wire as quota percentages.

## Verification

Run the focused MiniMax tests (`node --test tests/shared/minimaxLimits.test.js`) and `npm run verify`. Live checks require a key of the selected billing type in the selected region; Code checks require the official local login. Mock responses do not establish current endpoint or billing semantics.
