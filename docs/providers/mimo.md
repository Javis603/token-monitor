---
summary: "MiMo usage and limits: Console and Desktop Membership are separate products of one Xiaomi account."
ids: [mimo]
read_when:
  - Changing MiMo Desktop session discovery, exchange or membership limits
  - Changing Console wallet, Token Plan or multi-account behavior
  - Debugging missing MiMo identities or quota windows
---

# MiMo provider

Token usage reads the local `mimocode` SQLite store through tokscale; it does not use a limits credential. MiMo Code and MiMo Desktop map to the `mimo` tracked client (`tokscaleClientMapping.js`) and use its black colour, as decided upstream (#772 / #775).

Limits has two independent products under that provider:

| Product | Data | Credential |
|---|---|---|
| Console | Wallet, Token Plan and spend | Console Cookie, pasted or minted from Desktop's account session |
| Desktop Membership | Current subscription quota | Desktop's account Cookie, exchanged on each refresh |

Desktop endpoints and subscription fields were checked against the unpacked client. Live observations cover one macOS install and an account without membership; active-plan values in tests are fixtures, not paid-account responses.

## Local discovery and credentials

The measured store is `~/Library/Application Support/Xiaomi MiMo/Partitions/xiaomi-account/Cookies`, the app's `persist:xiaomi-account` Chromium partition. `desktop.js` opens SQLite read-only and selects only `passToken` and `userId` on `.account.xiaomi.com`. Selecting by name alone would include cookies on other domains; the partition also contains unrelated third-party sessions.

Both cookies are required for the measured exchange; dropping `cUserId` changes nothing. The measured rows are plaintext and contain no MiMo service cookies. Windows paths follow Electron's `%APPDATA%` rule but the Windows store is unverified. MiMo Desktop has no Linux build, so Linux uses the existing manual Console fallback.

The app's cookie-name login predicate indicates presence, not service validity. The exchange decides whether the account session is accepted. Discovery returns `{userId, cookieHeader}` or a status-bearing error:

| Store state | Result |
|---|---|
| Unsupported platform, no store, or readable store with neither required Cookie | `notConfigured` |
| I/O failure, missing `node:sqlite`, or a required Cookie available only as ciphertext | `unavailable`; retain last-good quotas without removal markers |
| Readable but incomplete plaintext session | `unauthorized`; attribute it to `userId` when available |

At-rest encryption does not prove logout. Recovery follows the shared retry cooldown; confirmed logout or account switching still removes old automatic identities. Without a known Desktop identity, a working pasted Console account stays alone; a lone incomplete Desktop source can show the shared `Sign in again` status. If no account exists, the enabled-provider `Not signed in` placeholder is the shared view fallback.

An enabled saved Console credential wins for its account. A disabled saved credential must not be revived by discovery, but does not disable that account's independent membership source. Settings lists the disabled manual source and active detected source separately. Detected rows have no editable/removable controls or raw credentials.

The existing manual form requires `api-platform_serviceToken` and `userId`; one Cookie covers wallet and Token Plan. Its allowlist, account keys and stored-account format remain unchanged. The membership lane has no manual entry: Console and membership use different Xiaomi service ids.

The tested inference `sk-` key did not authorize the checked billing routes: inference-host routes returned 404 and Console Bearer requests returned `401` with a login URL. This integration supports Console Cookies, without ruling out future key-authenticated billing APIs.

## Session exchange

Membership uses `https://mimo-server-cn.xiaomimimo.com/api`. CN is the only entry in the inspected client's region-to-host table; known other regions have no endpoint. An absent region is not evidence of a foreign account and does not suppress the quota request. The domestic client itself requires a CN account and rejects non-CN/KR logins; Token Monitor does not perform the app's logout operation.

| Service | Entry and login behavior | Service id | Service Cookies |
|---|---|---|---|
| Console | `/api/v1/balance` answers `401` with `loginUrl` | `api-platform` | `api-platform_serviceToken`, `api-platform_ph`, `api-platform_slh`, `userId` |
| Membership | `/api/user/xiaomi/me` redirects to Xiaomi login | `mimopc` | `serviceToken`, `mimopc_ph`, `mimopc_slh`, `userId` |

The shared walk visits `account.xiaomi.com/pass/serviceLogin`, then the service's `/sts` (`/api/sts` for membership), which sets service Cookies and redirects to the original endpoint. Valid account Cookies make it silent; rejected or absent Cookies land on the HTML login page and mint nothing.

Account Cookies are seeded host-only on `account.xiaomi.com` and HTTPS-only. The SSO's account-domain Cookies cannot reach either service host. `/sts` supplies `userId` under `.xiaomimimo.com`, satisfying the Console credential requirement. The measured `/sts` replies set a live host-scoped `*_slh` and delete its parent-domain variant; only the live variant is forwarded.

The membership callback includes `?userId=…`. Replaying the minted service Cookie against bare `/user/xiaomi/me` returned a redirect to SSO, while quota endpoints accepted it. Keep the exchange's callback identity step; the two services' Cookies are not interchangeable.

The account key uses the server-issued `userId` already in the account Cookie, never a rotating token. Live probes found the same id in the account Cookie, minted header and Console profile. An accepted exchange can reissue `passToken` with an observed 30-day expiry attribute; Token Monitor discards it. This does not establish server-side session lifetime.

Minted sessions stay in memory for one exchange and are never persisted or written back to Desktop. Each refresh reads the account Cookie again. There is no service-session cache or auth-failure re-mint, and long-term exchange tolerance is unknown.

### Transport and Cookie jar

Provider reads use the injected runtime transport. The exchange uses `deps.mimoExchangeFetch` when supplied, otherwise `deps.fetch`: it must inspect each redirect's `Location` and `Set-Cookie` without following automatically. Chromium `net.fetch` cancels `redirect: 'manual'` with `net::ERR_ABORTED`, so the widget supplies `src/electron/providers/mimo/exchangeFetch.js` to both collection and credential probes.

Explicit proxy environment settings retain the repository's precedence and `NO_PROXY` behavior. Otherwise the adapter resolves each host through Chromium's `session.resolveProxy` and tries its ordered system/PAC routes using undici. Unsupported proxy types fail unless a later supported route is available; cancellation stops every hop. A Chromium session cannot replace the private jar because its https-to-http cookie policy prevented this measured chain from completing.

Console requests retain the measured browser headers. `browserHeaders.js` sends Console `Origin`/`Referer` only to that host; membership and SSO omit them. No causal link between changed headers and account sign-out was established. Client-version/source headers vary by build and are not required.

Redirects allow only the original service host or Xiaomi login domains. Login-domain requests must use HTTPS; the current service-host exception permits HTTP callbacks. The jar enforces Domain/host-only, Secure, Path and expiry. Cookie identity is name/domain/path; absent or invalid Path uses the issuing URL directory, path matching uses a directory boundary, and longer paths are sent first. `Max-Age` overrides `Expires`; deletion/expiry applies to both redirected requests and returned credentials. undici supplies attribute parsing, with local handling for default paths and negative `Max-Age` that its parser does not provide.

### HTTPS evidence and shipping boundary

On 2026-10-03, a diagnostic using the repository's Node outbound transport upgraded each vendor callback to HTTPS before sending it. Both complete exchanges succeeded, followed by authenticated HTTPS reads:

| Flow | Vendor callback | Follow-up result |
|---|---|---|
| Console | `http://platform.xiaomimimo.com/api/v1/balance` | `/balance`: 200, `code: 0` |
| Membership | `http://mimo-server-cn.xiaomimimo.com/api/user/xiaomi/me` | `/user/xiaomi/subscription/self`: 200, `code: 0`, `current: null` |

This proves a working exchange and service read with an upgraded callback, not a vendor-native all-HTTPS chain or the widget's Chromium adapter. Production still follows the vendor HTTP URL. That hop carries the service Cookies listed above, not the original account Cookies; its response lacks transport authentication and integrity. The successful reads establish access to those endpoints, not broader authority or server-side lifetime. The maintainer decides HTTPS enforcement, defer/opt-in/default shipping; no lifetime or permission testing has established more.

## Console data

Earlier live probes read `/balance`, `/userProfile`, `/tokenPlan/detail`, `/tokenPlan/usage` and `/usage` successfully with minted credentials. The HTTPS diagnostic rechecked `/balance` only.

`/tokenPlan/detail` supplies the plan label: `planCode` / `plan_code`, then `planName` / `plan_name`. The shared helper capitalizes a leading lowercase letter; Desktop tier names do not translate Console codes. The fixture `standard` displays `Standard`, a tier in the [official Token Plan documentation](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription), not a default for all accounts or a live paid-plan result.

`/usage.costUsage.totalCost` and `currentMonthCost` supply provider-reported All time and Month spend. Today and Week use positive deltas of the cumulative total, matching Z.ai's local tracking; a drop rebases without negative spend. The API has no daily/weekly rollup; paginated call history and monthly bills are not queried.

Local tracking requires currency; an observation without it does not update the ledger. Writes are best-effort: after a failed write, the next observation compares with the persisted baseline and attributes missed spend to that later day. `trackingSince` describes local coverage; no `monthSinceTracking` is sent because Month is provider-reported.

The wallet reports native-currency money (`balance`, frozen/overdraft figures, `giftBalance`, `cashBalance`), with no quota cap or percentage. Its meter uses the existing display-only `creditsMeterPercent` fallback, `amount / (amount + monthSpend)`, as DeepSeek does. A provider-reported percentage takes priority; no derived percentage enters the wire.

## Membership data

The bundle registers `/user/xiaomi/subscription/self` without a main-process parser; the renderer validates `data.current`. A malformed data envelope or current plan is `unavailable`, not a successful missing subscription. An omitted or null `current` means no membership row; an older row is explicitly removed.

| `current` field | Desktop schema |
|---|---|
| `planCode`, `endTime`, `nextResetTime` | Required strings |
| `planTier` | Required integer |
| `percent` | Required number |
| `renewalMode` | Optional `MONTHLY`, `YEARLY`, `ONE_TIME`, or null |
| `source` | Optional string or null |

`groupCode`, `subscriptions` and fixture-only identifiers are not needed. The current-plan label follows Desktop: `source === 'INVITE'` suppresses the name while retaining usage; tiers map to `1: Starter`, `2: Plus`, `3: Pro`, `4: Ultra`; unknown tiers fall back to `planCode`. The separate renewal-mode tag is not part of the plan name.

MiMo Desktop's Settings weekly card reads **this subscription's** `current.percent` as remaining share and `current.nextResetTime` as reset time, using Desktop's `billing.weeklyLimit` / `billing.resetWeekly` labels. Publish one `kind: 'weekly'` window, preserving the returned reset instant and inverting remaining percent for the shared used-percent field. `renewalMode` describes billing cadence, not this window's duration. Do not invent `windowMinutes` or add a second window from `/user/usage`; that endpoint has a separate `{percent, resetDate}` parser and is not queried by this integration.

This follows the inspected client, not a measured paid-plan reset interval. Explicit-zone timestamps preserve their instant. Zone-less timestamps retain the existing Console UTC convention; Desktop formats them in local time. Controlled fixtures show that difference, but no active live response establishes the intended timezone or reset cycle.

## Status, identity and display

Exchange success requires `code === 0` and a nonempty `data.userId` for membership; Console accepts `code === 0`. Exchange failures map HTTP 401/403 or Xiaomi body codes 403/46109 to `unauthorized`, HTTP 429 to `sourceRateLimited`, login-page termination to `unauthorized`, and other unusable answers to `unavailable`. 46109 is a Xiaomi body code, not a real HTTP status. Membership quota reads classify HTTP 401 as unauthorized, 429 as rate limited, and other unusable replies as unavailable; they do not inherit the identity classifier.

| Live observation | Answer |
|---|---|
| Valid account, no membership | Identity has `userId`; subscription has `current: null`; `/user/usage` returned zero percent and null reset |
| Replayed old service Cookie | Usage returned empty-body 401; subscription returned `code: 401` |
| Rejected or absent account Cookie | Login HTML, no service Cookie |

Console keeps `hashKey("mimo:" + userId)`; membership uses `hashKey("mimo:membership:" + userId)`. Both products must have distinct row keys because Hub aggregation collapses rows with the same key. A different Desktop account can appear beside saved accounts. The logical account grouping uses the collector's shared `MiMo <fingerprint>` name suffix, then email/name, then row key; scoped membership refreshes reuse previously learned non-secret identity metadata.

Missing rows are transient in the shared runtime. Full refreshes emit internal `{provider, accountKey, removed: true}` markers for confirmed logout, account switches or ended membership. Removal is computed from the last accepted snapshot, so superseded probes cannot consume it. Runtime and one-shot collection strip markers before normalization; none reaches the wire. Scoped refreshes return only the selected product and defer removals to a full refresh.

Limits and Edge Dock reuse the shared provider heading/row frame. Healthy rows identify their data through Balance, Token Plan, Weekly and plan metadata; failed rows carry Console/Desktop Membership with the shared legacy title fallback. Account headings/counts appear for multiple logical accounts, not merely two products. Home keeps separate product bars; tray and native widget selectors use product labels, adding identity for multiple accounts. Composer choices use identity then product and keep the plan separate. Provider-wide subscription details are not repeated on account headings.

Settings remains one credential row per saved Console source or detected Desktop source. A membership-only failure stays in Limits. Either healthy product keeps the provider connected; if neither is healthy, the Console status takes priority. Rejected Cookie sessions use shared `Sign in again`; saving keeps the existing detailed `settings.mimo.invalidCookie` message. Saved Console Cookies report `web`/`managed`, Desktop sessions `local`/`app`.

Saving is a read-only, scoped Console probe: it does not write the spend ledger or run an unrelated membership exchange. Membership-scoped refreshes likewise skip Console requests. Discovered or minted credentials are never saved.

## Unverified conditions

- Live active Token Plan/membership responses, including active reset cycles and zone-less timestamp timezone.
- Windows cookie-store shape and encryption; unreadable/encrypted storage still uses the tested unavailable/retention behavior.
- Long-term exchange tolerance, broader credential authority and server-side lifetime. Successful short reads do not establish these.

## Verification

```bash
node --test tests/shared/mimo*.test.js tests/electron/mimoExchangeFetch.test.js
```

`mimoLimits.test.js` covers Console; `mimoDesktopLimits.test.js` covers composition, exchange, retention/removal and read-only SQLite with injected responses. Neither contacts MiMo. `mimoExchangeFetch.test.js` includes a real local CONNECT proxy. Rendering regressions live in the existing Limits, Home, Dock, tray and widget suites.
