---
summary: MiniMax independent Code and API lanes, resource units and credential ownership
ids: [minimax]
read_when:
  - Changing MiniMax limits, credentials, account identity, source selection or display
---

## Sources and resource pools

MiniMax Code OAuth and the configured API key are independent lanes collected together. `minimaxBillingMode` selects only the API key's billing type (`token-plan`, the historical default, or `api`). Code is detected from the current local login regardless of that selection. Adding or clearing a key never selects or signs out Code. Key prefixes do not override the selected billing type; Token Plan and API billing never fall back to each other. `MINIMAX_CODING_API_KEY` remains the existing environment credential; no new environment credential is auto-discovered.

| Lane | Credential | Readings |
| --- | --- | --- |
| Subscription | API key with `token-plan` selected | Current M Plan or retained Token Plan quota, with the existing legacy Coding Plan fallback |
| API | API key with `api` selected | API wallet balance and optional server-reported cash Spend |
| Code | Current local MiniMax Code OAuth login | Code points and applicable Code plan quotas |

M Plan extends the earlier Token Plan product; both can be observed through a subscription key or Code OAuth. The compatibility setting `token-plan` selects subscription-key billing, not the product generation. The `5h` and `Weekly` windows constrain the credential's current subscription; endpoint paths containing `token_plan`, the authentication source and the mere presence of those windows do not identify its generation or prove separate pools. Use the matched current subscription's type/title for that distinction, never the catalog's new-plan availability flag. Do not create an additional M Plan lane or add overlapping observations as extra allowance.

The producer of a request, the credential used to observe it, and the resource paying for it are different facts. Never assign cost from the client name, login method or token count. A Code action may consume quota, points, vouchers or cash; use the relevant server reading.

Code points use `CREDITS`, never CNY/USD. Membership's `op_credit_summary.total_remaining_amount` already combines purchased and gifted points: component balances must not be added again or emitted as independent balances. Purchased points are shared between Code and Open Platform; gifted check-in points are Code-only. Plan quotas and the pay-as-you-go cash wallet remain separate pools. Eligible Code points can cover usage after a plan limit when the user's fallback setting allows it; grants are consumed by expiry order, not an assumed paid-first or gifted-first rule.

## Wallet and Spend

API wallet balance comes from `/account/query_balance.available_amount`, including usable vouchers, rather than `cash_balance` alone. Zero and negative balances are valid; a missing or nonnumeric amount is unavailable. Balance and cash Spend measure different things and must not be subtracted to reconstruct transactions.

| Spend field | Server source |
| --- | --- |
| Today | `/account/amount`, dated `aggregate=true`, `consume_cash_after_voucher_sum` |
| Week | The same aggregate over seven calendar dates including today |
| Month | The same aggregate from the first calendar date of the month |
| All time | `/account/query_recharge.cash_total_usage`, with the console's `page_num=1&page_size=10` |

Periods use the console's calendar-date filters. Bills refresh daily and can lag the current wallet. All time means MiniMax's reported cumulative cash usage; the endpoint does not establish complete lifetime bill retention or real-time settlement. Cash Spend excludes voucher-funded consumption. Do not replace a valid post-voucher zero with `consume_cash_sum`, add voucher `used_amount`, substitute recharge totals, or sum rounded rows from a partial page. Voucher summary counters are not consumption totals for the selected issuance dates.

These are replacement snapshots, not increments. There is no MiniMax local Spend ledger, balance-delta fallback or tracking baseline. Optional Spend reads use the same selected key, resolved region and injected transport as the valid balance. A failed, denied or malformed optional result leaves that figure unknown without invalidating the balance, changing region or selecting another credential. Save-time probes skip Spend enrichment.

Code OAuth does not query the API wallet or cash-billing endpoints and never borrows the retained API key. Its status and points are independent of API credential failures. A Code action's payment pool does not establish which API credential can observe it: same-group evidence alone does not prove complete cross-key or team coverage. Do not automatically merge these lane identities or assign API Spend to Code.

OAuth and a Token Plan key can observe the same subscription's quota. Those readings are separate observations, not additional allowances; do not add them together or infer common ownership merely because their limits match.

## OAuth ownership and interoperability

Discovery follows the [mcode data-directory rules](mcode.md), using `auth/prod/{cn,en}/mcode-public`. A pinned region selects one namespace; Auto prefers China. Each namespace contains one current login, not a managed account list. Local record keys identify storage, not the user. Preserve unrelated records and reread credential/state files rather than retaining a stale lease. Only file-backed official credential/state formats are supported.

Select exactly one `workspace_type: 0` personal workspace through `POST /matrix/api/v1/user/get_user_extra_info`; workspace ID `0` is valid. Pass that workspace explicitly to membership. Missing or ambiguous personal workspaces are unavailable; never change the official client's default workspace. Identity prefers the workspace's `op_group_id`, then membership's. A malformed membership total falls through to the workspace balance, then the membership scalar. A present malformed workspace balance does not.

Plan requests require a group and a plan indicated by `has_token_plan` or `token_plan_tier`; `has_valid_subscription` is unreliable. Code uses the platform `remains_percent` endpoint with `X-Group-Id`: its percentages are used amounts, unlike the API-key endpoint's remaining percentages. Video uses that endpoint's `current_interval_used_count` and `current_interval_total_count`; the legacy endpoint's `current_interval_usage_count` has different semantics and must not be substituted. Status 3 means unlimited. `2062` omits an absent plan, while `1004` requires auth recovery. A transient plan failure keeps fresh points and uses shared partial-window retention rather than discarding the account.

The plan predicate reports an entitlement hint, not a verified paid-subscription state: workspace or membership `has_token_plan`, or a nonempty tier, enables the quota read. It does not establish payment, auto-renewal, trial status or expiry, and no product-generation classifier consumes `current_subscribe_combo_type`. A quota `2062` removes quota windows but does not override the earlier label; a reported plan name without current quota is not proof of active paid service.

Code's `accountLabel` names the product, never the subscription. The plan cell uses `planLabel`: workspace `token_plan_tier` precedes membership's. Textual tiers supply the name; numeric IDs or a known plan without a name use a generic `Token Plan` label. Without a token plan, membership `plan_name` may name the Code membership. Do not derive a tier from quota size, point totals or the `MiniMax Code` product label.


Credential refresh must respect the official app's ownership:

- Do not start exchanges during probes, while MiniMax Code runs, when process detection fails, or when the official `auth.lock.lock` mutex is busy. Never steal abandoned or replaced locks.
- Use the regional account token endpoint, `client_id=mcode-public`, `scope=agent.default` and `audience=agent-backend`. Refuse redirects and custom `MCODE_OAUTH_*_ENDPOINT` overrides. Validate Bearer type, required scope and positive expiry; do not extend a short grant locally. Decoded token metadata is not authenticated account identity.
- Reserve the official generation/refresh transaction before exchanging. Writes require ownership of both that transaction and the original-or-committed credential lease; publish authenticated state last. A changed login, logout or lease must not be overwritten.
- Once rotation starts, finish and persist its successor through the same transport's uncancelled credential exchange, even if usage collection is superseded. Bound the exchange independently. An uncertain network response still cannot guarantee recovery.
- Keep a successfully issued but not yet persisted grant tied to its transaction for write retry; do not exchange again or fall back to its predecessor while the fence is refreshing. Transient file-read failures do not establish a new login. Retry a committed generation only when it exactly matches the refresh fence.
- Only HTTP 400 `invalid_grant` makes the shared state anonymous, matching official OAuth Core classification. Retain the credential behind that fence; never reuse it. Other exchange failures are unavailable and may reuse an access token only while its current lease remains authenticated and unexpired.

One refresh serves proactive expiry recovery within a 10-minute leeway and one resource retry after HTTP 401/403 or business code `1004`. Preserve the previous refresh token if the official grant omits a successor; otherwise replace it. The new grant's scopes replace old scopes in both files. Token Monitor does not implement the official durable refresh journal: a crash before the successor reaches disk can require official-client recovery or re-login.

## Account identity and aggregation

Code identity hashes the server's regional group. Manual API-key identity retains its existing key hash. Matching readings select one observation through shared aggregation; amounts are never added across devices. Different or unverified keys stay separate. There is no automatic alias or stored-key migration. One current Code login and one API key can coexist locally; multiple managed Code logins are unsupported. That pair is two lanes on one card and does not use numbered account titles or an account count. Product labels do not replace subscription names in the plan cell. Any other mix keeps ordinary account titles. This is display classification by source, not a merged account key.

An identified successful Code reading may retire the prior local OAuth identity through shared removal markers. A failed or unidentified read cannot prove logout or create a replacement account. Scoped work for a retired account must not adopt a newly logged-in account. Use the shared runtime's cancellation/revision checks; removal markers never enter the wire payload.

Subscriptions and top-ups bind to an exact saved account key. A matching label/email or the sole remaining account does not prove the same wallet. Keep saved-only accounts available to the shared settings picker while their live reading is unavailable. Any future cross-source identity change must preserve existing bindings rather than simply replacing hashes.

Provider subscription metadata is separate from saved cost records in `settings.subscriptions`. A detected plan name may prefill the editable cost form, but never creates an expense record, supplies its price or establishes its renewal schedule. Those records still require the user's form submission.

## Regions, settings and shared display

Explicit `minimaxApiRegion` wins over legacy `minimaxApiHost`, then `TOKEN_MONITOR_MINIMAX_API_REGION`, `MINIMAX_API_REGION` and `MINIMAX_API_HOST`. Aliases are exact. An unchosen setting stays empty and resolves the environment at use time; an explicit Auto is stored as `auto`. The wire keeps `cn`/`en`, distinct from settings' `intl`/`auto`.

For API-key sources, Auto first tries the runtime's last region that returned quota windows, or International when none is remembered. A pinned region never crosses regions. HTTP 401/403, business `1004` (including its HTTP 400 form), and transport failures may drive the existing fallback; ordinary 400 errors, 5xx, 429 and JSON errors do not. After a transport failure followed by an auth rejection, report unavailable rather than invalidating a potentially valid key. Remember a region only after a usable reading.

Credentials stay in main and calls use the injected transport. Key billing type and region save independently; credential submission waits for those writes and does not overwrite them from a stale draft. Key/type edits clear only API readings; the shared region setting invalidates both lanes. Replacing or clearing the local key retires its old API identity without retiring Code. Save-time key validation never reads or renews Code. Browser links follow the selected billing type and pinned or last-successful region through the declared URL policy.

Reuse shared account rows, sign-in states, privacy handling, balance formatting, Spend tooltip and hide/show behavior. Settings keep the automatic connection explanation separate from the key form, like other automatic-plus-manual providers. Either healthy lane keeps the provider summary live, while the key form status reads only the local API lane. Both Code points and the API wallet use `metric: 'credits'` with their own units. The `billing` window kind does not make points currency.

Membership alone supplies no points denominator. Optional active credit details may supply a bar only after complete pagination, valid grant/remaining/expiry fields, exclusion of expired grants, and reconciliation against that same membership total within half a hundredth of a point. Otherwise retain the fresh amount without a bar. Expiry is not spend, and independent grant expiries do not imply one reset date. API wallet meters remain shared display-only values, never wire percentages. Team collection and simultaneous managed Code logins are unsupported.
