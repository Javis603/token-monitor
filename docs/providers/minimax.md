---
summary: MiniMax billing type, region selection and endpoint fallbacks
ids: [minimax]
read_when:
  - Changing MiniMax billing type, region selection, credentials, or endpoint fallbacks
---

## Data sources

`minimaxBillingMode` selects `token-plan` (the default for existing installations), `api` (pay-as-you-go), or `code` (MiniMax Code OAuth). Token Plan keeps its quota endpoints and legacy Coding Plan fallback. API billing queries `/account/query_balance` on the selected MiniMax API host, as implemented in the [official MiniMax CLI](https://github.com/MiniMax-AI/cli/blob/a965e72ce424e465ae65ded102315bf73bef0aa3/src/client/endpoints.ts). It uses `available_amount`, not the cash-only balance, and emits one `credits` window in CNY for China or USD for International. Zero and negative balances are valid responses; missing or nonnumeric amounts are unavailable. No quota percentage, reset time or spend history is inferred.

The `code` tier needs no pasted credential at all: it reads the local MiniMax Code login (the desktop app's OAuth lease, discovered under the [mcode data directories](mcode.md) at `auth/prod/<region dir>/<record dir>/auth.json`), renews it when it is about to expire, and reports the account's sign-in credits plus its M Plan windows. Its three books never mix with the API-key lanes: sign-in credits (`op_credit_summary.total_remaining_amount` from `POST agent.minimaxi.com/matrix/api/v1/commerce/get_membership_info`, a bare Bearer call) are a `credits` window, and the M Plan rides `GET www.minimaxi.com/v1/api/openplatform/coding_plan/remains?GroupId=<op_group_id>` (international: `platform.minimax.io`; `GroupId` is a query parameter — the header form is ignored) through the same `model_remains` parser as Token Plan. `base_resp.status_code 2062` there means "no subscription" and only omits the plan windows; `1004` is an auth failure. A missing `op_group_id` simply skips the plan lane. Switching tiers never carries readings across: the modes are mutually exclusive by selection, and any summing of sign-in credits with API-key platform balance would be wrong by construction.

Billing types never fall back to each other's endpoints. The selected type applies to both the credential-save probe and later collection; key prefixes do not override it. `MINIMAX_CODING_API_KEY` remains the Token Plan environment credential, and no new environment credential is auto-discovered.

## Source precedence

An explicit `minimaxApiRegion` choice wins over the legacy probe option `minimaxApiHost`, then `TOKEN_MONITOR_MINIMAX_API_REGION`, `MINIMAX_API_REGION`, and `MINIMAX_API_HOST`. Region and hostname aliases are exact matches. The default is `auto`: probe the last region that returned parseable quota first, or international first when no success is remembered. The other region remains a fallback for authentication rejection or transport failure. A China/International selection from settings or env always pins that region ahead of memory and prevents cross-region requests.

Within each region, the Token Plan endpoint falls back to the legacy Coding Plan endpoint on the existing migration/error signals. A transport failure skips the remaining endpoint on the unreachable host. Runtime cancellation stops the probe without retrying another region; a per-request timeout remains eligible for fallback. HTTP failures such as 5xx or 429 and JSON parse failures do not trigger a cross-region retry.

## Credentials and transport

The API key stays in the main-process credential store. Region or billing-type changes retain the key, clear the old quota, and immediately refresh only MiniMax through the normal settings invalidation path. Calls use the injected transport and fixed MiniMax API URLs.

The `code` tier has no credential field, no paste panel probe and nothing in the credential store. Discovery enumerates `auth/prod/<region dir>/<record dir>/auth.json` (directory names are never hardcoded: `cn` is the verified spelling, anything else is treated as the international store, whose directory name is unverified); a pinned region filters the stores, Auto prefers `cn`. The target record is the desktop app's own (`clientId` `mcode-public`, key `com.minimax.mcode.oauth…`); a `records` map may hold several records and only the refreshed one is ever written. auth.json is re-read every tick — a re-login inside MiniMax Code heals an `unauthorized` lane on the next tick with no settings change.

**Managed refresh.** The refresh token is strictly single-use: every accepted refresh rotates it. The refresh (`POST account.minimaxi.com/oauth2/token`, international `account.minimax.io`) must send `grant_type=refresh_token`, `client_id=mcode-public`, `scope=agent.default` and `audience=agent-backend` alongside the token — a refresh missing `scope`/`audience` still returns 200 but every resource server then rejects the minted token. `expires_in` is relative seconds (the CLI's `expired_in` field name is wrong). The rotation is written back synchronously in the same tick (tmp file mode 0600 + rename, only the refreshed record's own fields, `generation` +1, auth-state.json mirroring `generation`/`expiresAtMs`); a lost write-back means a lost lease, so a failed write sets a force-refresh marker for the next tick rather than being swallowed. Refresh runs proactively inside a 10-minute leeway and passively after one 401 (refresh once, retry once), but **never while the MiniMax Code app is running** (best-effort process detection) and never on a credential probe (`deps.probe`): while the app runs, the lane only reads the on-disk token and reports a 401 as transient, because the app may be mid-rotation itself. `invalid_grant`/`unauthorized_client` map to terminal `unauthorized`; 5xx and transport failures retry at most twice and stay `unavailable`.

If the fallback region rejects the key after a transport failure, report `unavailable` so the runtime retains the last known quota instead of prompting for a replacement key. When every attempted region rejects the key without a transport failure, report `unauthorized`.

## Invariants and known gaps

An unchosen region stays empty in stored settings. Renderer projection and runtime config resolve the environment at use time; displaying Auto or saving a key must not freeze an implicit default. An explicit Auto selection is stored as `auto` and overrides the environment. The form's region saves independently (`submitWithCredential: false`); writes are serialized per field, and key submission waits for queued writes and omits the region from its credential draft. Failed writes show a panel message and leave the queue so later submissions can retry after settings resync.

The billing type also saves independently and stays visible after linking. Credential submission waits for that save and omits the type from its draft, so a stale renderer value cannot override the saved selection. The `code` tier keeps the API-key field in the panel for the other tiers (the save path has no per-tier validation by design) but explains itself with a conditional note; the tier is selected and saved by the select alone.

On the `code` tier: the access token is opaque (never parsed); `has_valid_subscription` is unreliable (use the remains `2062` or membership `has_token_plan`); a locally expired `expiresAtMs` still attempts a refresh, because the server is authoritative; the credits window's currency follows the record's region (CNY/USD) like the API lane. The international membership host (`agent.minimax.io`) and the international storage directory spelling are unverified — both follow the verified CN spellings and are the first suspects if an international login does not light up.

Open Browser follows the current China/International selection, including before the first successful probe. Auto follows the last successful probe's `en`/`cn` region, with the historical China landing page until a successful result exists. The wire region keeps `en`/`cn`; the setting's `intl`/`auto` vocabulary never replaces it.

The browser path follows the billing type: Token Plan opens its plan page, and API billing opens the balance page. The descriptor's `pathByField` uses only declared paths, validated against the provider URL policy for every region.

Region memory lives in the runtime's `providerRuntimeState` and resets with a new runtime. Only responses with quota windows update it; unavailable responses leave the last successful region intact. Changing a key can still resolve the other region through Auto's fallback.

## Verification

`node --test tests/shared/minimaxLimits.test.js tests/electron/limitAccountPanels.test.js tests/electron/limitProviderWiring.test.js tests/electron/credentialCommands.test.js` covers billing endpoint selection, balance parsing, region parsing, remembered-region precedence, transport and endpoint fallbacks, runtime quota retention, setup links, saved-settings/env precedence, and credential submission. The `code`-tier cases live in the same minimax suite: record discovery (nested `records`, space keys, multi-record isolation), refresh form fields and `expires_in` conversion, `invalid_grant`/`unauthorized_client`/5xx classification, atomic write-back and the force-refresh marker, 2062 vs 1004, `GroupId` as a query parameter, region pinning, the client-running and probe suppression rules. Live verification of the `code` tier requires a signed-in MiniMax Code (quit the app first); the API-key tiers require a key of the selected billing type in the selected region.
