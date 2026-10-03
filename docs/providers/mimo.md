---
summary: "MiMo token usage and limits: Console and Desktop Membership are separate products of one Xiaomi account, backed by ephemeral sessions minted from MiMo Desktop's local account cookie."
ids: [mimo]
read_when:
  - Adding or changing the MiMo Desktop membership limits source
  - Debugging a MiMo limits row that reads not-configured, unauthorised or empty
  - Changing how MiMo Desktop's local session is discovered or exchanged
  - Touching the platform console (wallet / Token Plan) lane or its credential
---

# MiMo provider

Token usage and limits use separate collectors and credentials.

| Plane | What it measures | Runtime | Credential |
|---|---|---|---|
| Token usage | Local `mimocode` SQLite via tokscale, reported under the `mimo` tracked client | collector | none (reads the engine's own store) |
| Limits — platform console | Open-platform wallet balance, Token Plan credit and reported spend | limits | console session, mintable from the machine's account cookie (or pasted by the user) |
| Limits — Desktop membership | The Xiaomi-account membership quota from the current subscription | limits | MiMo Desktop's own account cookie, exchanged on demand (below) |

The tracked client keeps its own identity rules: MiMo Code and MiMo Desktop are one row (`tokscaleClientMapping.js` maps both onto `mimo`), and the colour is black, not Xiaomi orange — both decided upstream (#772 / #775).

Desktop endpoints and subscription fields were checked against the unpacked client; Console behavior was also checked through live requests. Live observations cover one macOS install and an account without membership, not every platform or subscription state.

## Credentials and exchange

The Desktop bundle registers these endpoints:

| Purpose | Request | Notes |
|---|---|---|
| Account identity | `GET {base}/user/xiaomi/me` | The exchange driver (see below). Success is `code === 0` with `data.userId` |
| Membership usage | `GET {base}/user/usage` | `{percent, resetDate}` — not the Settings weekly card (see Membership window) |
| Subscription | `GET {base}/user/xiaomi/subscription/self` | `{groupCode, current, subscriptions}` |
| Logout | `{base}/user/xiaomi/logout` | What the app calls when the user signs out; revokes server-side **and** clears the partition's cookies |

`{base}` is `https://mimo-server-cn.xiaomimimo.com/api`, built by the app as `https://${host}/api` from a region table whose **only entry is CN**. The app can name other regions — it maps a country list onto IN/RU/EU/SGP — but the lookup returns **null** for all of them, so a non-CN account resolves no base URL and the membership lane cannot run for it.

This build is the domestic edition: `editionDefault` and `fallbackRegion` are CN and `requiresCnAccount` is `true`, which makes the app **revoke** a login whose account region is not CN, and a `KR` account unconditionally. The region is the *account's*, not the network's: an account registered in mainland China answers CN from anywhere.

### Session exchange

The session is established by following a redirect chain with the **account** cookie present:

```
GET {base}/user/xiaomi/me
  -> 302 account.xiaomi.com/pass/serviceLogin?callback=…/api/sts?sign=…&followup=…/api/user/xiaomi/me&sid=mimopc
  -> 302 {base}/sts                 (silent: passToken accepted, no login page)
  -> 307 {base}/user/xiaomi/me
  -> 200 {"code":0, "data":{"userId": …}}
```

The hop through `/api/sts` is what **mints the service session**, and the cookie jar gains `serviceToken`, `mimopc_ph`, `mimopc_slh` and `userId` — the last under `.xiaomimimo.com`, so it covers the service host. The measured response sets a host-scoped `mimopc_slh` and deletes its parent-domain variant with a past `Expires`; the console does the same with `api-platform_slh`. Only the live variant is forwarded. `passInfo`, `pass_ua`, `deviceId` and `ptn_count` belong to the SSO hop above it rather than to this one, and stay on the account hosts. Measured on a live exchange, the membership host receives `serviceToken`, `userId`, `mimopc_ph` and `mimopc_slh`. The service id is `mimopc`, and the login is driven by visiting the API — the app carries no URL that constructs it.

- **Exchange-minted service cookies stay in memory.** They are this exchange's output, and the membership lane's only credential is the account cookie it was minted from: the account cookie is read again on every refresh, and nothing minted here is stored.
- **A service cookie is not a substitute for the identity hop.** Measured: a freshly minted `serviceToken` set answers `/user/xiaomi/subscription/self` and `/user/usage` with `code: 0`, and is answered by `/user/xiaomi/me` with a **302 back to the SSO**, so it carries no identity and no region reading. What makes that hop answer 200 is where `/sts` sends the client — `/api/user/xiaomi/me?userId=…`, a query the redirect carries — rather than the cookies: the minted set replayed against the bare path answers 302 whether it is sent whole or as `serviceToken` alone. Nothing else needs that distinction today — the lane has no paste — but the console lane's service cookie is a different service's and would not work here either.
- **An accepted exchange re-issues `passToken`.** Observed expiry attributes extend 30 days; they do not establish the server's session lifetime. Token Monitor discards the refreshed value and never writes it back. A missing local cookie uses the normal silent fallback.
- **The exchange is silent while the account cookie is valid.** When it is rejected, the chain stops at `account.xiaomi.com/fe/service/login` and **mints nothing** — the refusal signature, detectable with no interactive step.
- **The vendor callback still names HTTP.** On 2026-10-03, a diagnostic transport upgraded that callback to HTTPS for each complete exchange, then read Console `/balance` and membership `/user/xiaomi/subscription/self` over HTTPS; both returned `code: 0`. This was a Node outbound-transport probe, not the widget's Chromium adapter or a vendor-native all-HTTPS chain. Production still follows the vendor URL. Its HTTP callback carries the newly minted service token, `userId`, `*_ph` and live `*_slh`; the original account cookies are HTTPS-only. The HTTP response has no transport authentication or integrity protection. The successful reads establish access to those service endpoints, not wider account permissions or server-side lifetime. Whether to require HTTPS or make automatic exchange opt-in remains a maintainer decision.
- **The account session is one named partition**, `persist:xiaomi-account`. The app sets `X-Client-Version` and `X-Mimo-Source` on those requests; **neither is required and nothing may key on either** — their values vary by build.
- **Keep the measured request headers.** `browserHeaders.js` sends Console `Origin` and `Referer` only to the Console host; Desktop's membership calls omit them. A causal link between omitted headers and account sign-out has not been established.
- **Redirects are allowlisted per hop.** HTTPS may stay on the original service host or move through Xiaomi login domains; the service host may also answer over plain HTTP, because its callback returns to the endpoint that started the walk (`/api/v1/balance?userId=…` for the console, `/user/xiaomi/me` for the membership) rather than to a `/sts` path. Set-Cookie parsing uses undici’s public `parseCookie`; the exchange jar enforces host/domain, Path and expiry, and withholds `Secure` cookies from HTTP.
- The walk's transport is chosen at the **runtime boundary** like every other provider call; see Transport.

### Account cookie on disk

`~/Library/Application Support/Xiaomi MiMo/Partitions/xiaomi-account/Cookies` — the app's own Electron partition, the one its login window uses. A Chromium SQLite cookie store, so the read is a read-only `DatabaseSync` open, the shape `readCursorDesktopAccessToken` already establishes for another app's store.

macOS is measured. Windows is unverified: the path follows Electron's documented `%APPDATA%` rule under the same `Xiaomi MiMo` product root, and nothing about that store has been observed on a Windows install. MiMo Desktop ships for macOS and Windows only, so Linux has no store to read and falls back to the existing manual console-cookie flow.

Two facts about its **contents** are load-bearing, both measured:

- **The measured account cookies are on `.account.xiaomi.com`.** `.xiaomi.com` carries its own `cUserId`, so selecting by cookie name alone is ambiguous. The measured partition contained no `.xiaomimimo.com` service cookies; the provider mints them instead of reading them from disk.
- **The partition is not only MiMo's.** The same store holds unrelated third-party login cookies, so the read must be scoped to the account host rather than sweeping the store, and **anything forwarded must come from an exact allowlist** — the rule `providers/commandcode` states, that everything outside the session-cookie allowlist is a credential the endpoint has no business receiving.

On the measured machine every row is **plaintext** (`value` populated, `encrypted_value` empty), so no keychain read is involved. An unreadable or encrypted store is not evidence that the user signed out; the status handling is described under Session reader.

Two cookies are load-bearing: dropping **`passToken`** or **`userId`** stops the exchange at the login page and mints nothing, while dropping `cUserId` changes nothing.

### Login predicate

The app decides "signed in" by cookie **names** (`passToken` | `serviceToken` | `*_serviceToken` | `*_ph`). It is not domain-aware and says nothing about whether the endpoints answer.

Discovery must therefore treat name-matching as *presence only* and let the exchange decide *validity*.

### Console session

The console is a **different service on the same Xiaomi SSO**, and its session can be minted from the same account cookie. Its shape differs from the membership lane in one way: it does **not** answer with a 302 but with `401` and a JSON body carrying the login URL the client is expected to visit:

```
GET https://platform.xiaomimimo.com/api/v1/balance
  -> 401 {"code": 401, "loginUrl": "https://account.xiaomi.com/pass/serviceLogin
            ?callback=https://platform.xiaomimimo.com/sts?sign=…&followup=…/api/v1/balance
            &sid=api-platform&_group=DEFAULT"}
visit loginUrl
  -> 302 https://platform.xiaomimimo.com/sts
  -> 307 <the original endpoint>
```

Both hosts in that chain set cookies, and only the second hop's are in scope for the console:

| Hop | Sets | Scope |
|---|---|---|
| `account.xiaomi.com` (the SSO) | `deviceId`, `passInfo`, `pass_ua`, `uLocale`, `theme`, `passToken`, `cUserId`, `ptn_count`, `userId` | `account.xiaomi.com`, `.account.xiaomi.com` and `.xiaomi.com` — no scope that matches the console host |
| `platform.xiaomimimo.com/sts` | `api-platform_serviceToken`, `api-platform_ph`, `api-platform_slh` | `platform.xiaomimimo.com` |
| the same `/sts` answer | `userId`; deletion of the parent-domain `api-platform_slh` | `xiaomimimo.com`, so `userId` also covers the console host |

`userId` is the one worth stating outright, because the console lane requires it beside `api-platform_serviceToken` and only one of the three copies can be sent: the account cookie's own `userId` is seeded host-only on `account.xiaomi.com`, and the SSO hop re-issues one under `.account.xiaomi.com` — neither scope matches the console host, so the `/sts` answer's copy is the one that answers the requirement. Measured on a live exchange, the header that host receives is exactly `api-platform_serviceToken`, `userId`, `api-platform_ph`, `api-platform_slh`; the expired parent-domain `slh` is excluded. Earlier live probes read all five console endpoints successfully with minted credentials: `/balance`, `/userProfile`, `/tokenPlan/detail`, `/tokenPlan/usage` and `/usage`. The HTTPS diagnostic above rechecked `/balance` only.

`/tokenPlan/detail` supplies the Console plan label: the existing reader prefers `planCode` / `plan_code`, then `planName` / `plan_name`. The shared display helper capitalizes a leading lowercase letter; it does not translate Console codes through the Desktop membership tier map. The `standard` test fixture therefore displays `Standard`, a tier listed in the [official Token Plan documentation](https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription). That fixture is not a live paid-subscription response, and `Standard` is not a default assigned to every account.

`/usage` is the only console summary that reports spend. `costUsage.totalCost` is all-time money spent and `currentMonthCost` is the month figure shown by the row. The endpoint has no daily or weekly rollup, so the row's `todaySpend` and `weekSpend` are tracked locally as positive deltas of that cumulative total — the derivation z.ai's report also uses, and the one `docs/API.md` documents — while `monthSpend` and `allTimeSpend` stay the console's own figures. The paginated call ledger and monthly bill endpoint are intentionally not queried.

Local spend tracking requires the console's currency. An observation without it does not change the ledger. Writes are best-effort, as in Z.ai: after a failed write, the next observation compares with the persisted baseline, so missed spend is attributed to that later observation's day.

The wallet itself reports money only: `{balance, frozenBalance, currency, overdraftLimit, remainingOverdraftLimit, giftBalance, cashBalance}` — no cap and no percentage of its own. The meter the row draws beside it is therefore **derived at display time** (`amount / (amount + monthSpend)`, `creditsMeterPercent` in `src/shared/limits/balanceDisplay.js`), never a wire value. That derivation is the fallback for a money window carrying no percentage of its own, which is what deepseek's balance window is; openrouter's credits window reports a real `usedPercent`, so `creditsMeterPercent` returns that instead and never reaches the rule.

Both lanes therefore resolve the same way: an account cookie already on the machine, exchanged per refresh for a session that is never stored. The console lane keeps the manual paste as its fallback where no MiMo Desktop is signed in; the membership has none, because it is not sold on the developer platform.

### API keys

The tested `sk-` credential did not authorize the billing routes checked: those inference-host routes returned 404, and the Console API returned `401 {"code":401,"loginUrl":…}` for Bearer authentication. This integration supports Console Cookies for wallet and Token Plan limits, not inference keys. These checks do not rule out other or future key-authenticated billing endpoints.

## Response contracts

### Membership window

`/user/usage` has a separate parser in the app. It is not the source of the Settings billing panel's weekly card and Token Monitor does not query it.

**The weekly card reads `/user/xiaomi/subscription/self`.** The billing panel rounds `current.percent` for its progress bar and remaining-percentage text, and reads `current.nextResetTime` into the reset line. That same card uses `billing.weeklyLimit` and `billing.resetWeekly`; `renewalMode` supplies the separate monthly/yearly plan tag.

- The percentage is therefore a **remaining** share on a 0–100 scale, not the platform console's used-ratio. Do not reuse the console lane's normalisation.
- **Judge plan state by `current` being absent, never by `percent`.** The app's own test is the loose one (`t == null`), so a payload that omits `current` is the same answer as one that states it as null.
- An invalid `data` envelope is unavailable, not a successful no-subscription answer; it must not remove the last good membership.
- **Match Desktop's weekly display.** Publish `kind: 'weekly'` and let the shared window label name it. `resetsAt` comes from `current.nextResetTime`; do not invent `windowMinutes` or calculate a reset from `renewalMode`.
- **There is one quota window in the parsed subscription.** Do not add a second window from `/user/usage`.

This mapping follows the current client's display contract, not a measured server reset interval. Live reads on the test account return `current: null`; active percentages and reset times in the tests come from the app's E2E fixture. An active membership's reset cycle and timezone remain unverified.

Timestamps with an explicit zone preserve the same instant as Desktop. Zone-less timestamps still follow the existing console reader's UTC convention; Desktop's date formatter instead treats them as local time. Controlled fixtures reproduce that difference, but no active live response establishes which timezone the service intends. Do not silently change the shared console convention to resolve this membership gap.

### Subscription response

There is **no parser in the main bundle**: the request is registered without one and its `data` passes through as `unknown`. The renderer validates `data.current` against a schema whose first five fields are **required** — a `current` missing any of them throws, and the panel renders its `failed` state rather than a partial plan:

```
planCode       string    required
planTier       integer   required
endTime        string    required
percent        number    required
nextResetTime  string    required
renewalMode    "MONTHLY" | "YEARLY" | "ONE_TIME" | null   optional
source         string | null                              optional
```

A `current` that is an array is invalid, the envelope's `groupCode` and `subscriptions` are read nowhere, and only `current` matters. The bundle's own fixture also carries `id`, `title`, `status`, `startTime` and `bizNo`; nothing reads them, so nothing should depend on them.

Token Monitor treats no current plan as a successful no-subscription answer and omits the membership row. If a previous membership row existed, the runtime-only removal marker clears it without putting a normal no-plan answer into the transient retry path.

Plan names follow the app's current-plan card:

```
source === 'INVITE'   -> no current-plan label; usage still renders
planTier ∈ [1, 4]     -> the tier name from the app's billing.planTier map
otherwise             -> the vendor's planCode
```

The tier map is `{1: Starter, 2: Plus, 3: Pro, 4: Ultra}` (the app's `zh` locale translates the same four). The app joins a renewal mode onto the name for its own sidebar; a limits row carries one plan label, so the renewal mode is not part of it.

### Account classifier

The exchange classifies its final identity response; subsequent quota requests classify their own failures separately.

Success is exactly `code === 0` **and** a non-empty `String(data.userId)` — the app's own test. Anything else is not a session, and *which* refusal it is decides the status the row carries:

| Observation | Status |
| --- | --- |
| body `code` is `403` or **`46109`**, the HTTP status is one of those, or it is 401 | `unauthorized` |
| 429 | `sourceRateLimited` |
| the chain ended on the account host instead of the service | `unauthorized` |
| a 200 that is not the answer, or any other failure | `unavailable` |

So a 500 reads as an outage rather than a signed-out app, and a body-level `46109` is a refusal without the code itself being carried any further.

`46109` is Xiaomi's own auth code and is not an HTTP status — it is why a MiMo refusal can arrive as a perfectly ordinary 200 and still mean the session is gone. The classifier also carries the account's `region`, which is what selects the base URL. A region the app does not carry has no host at all, so the membership lane goes quiet for one; an **absent** region is not evidence of a foreign account — there the call proceeds and the endpoint answers for itself.

**The account id must come from the server-issued `userId`, never from a rotating token.** Measured: the `/sts` answer re-issues that same id under `.xiaomimimo.com` rather than minting a new one, and `/userProfile` reports it back unchanged — all three copies (the account cookie's, the minted header's, the profile's) hold one value. The code still takes the copy the account cookie already carries instead of parsing the minted header, which keeps the account key independent of how a given exchange shaped its cookies.

## Live signatures

| State | What the endpoints answer |
|---|---|
| Valid account cookie, no membership | `me` → `code=0` with `userId`; `usage` → `code=0` `{percent: 0.0, resetDate: null}`; `subscription` → `code=0` `{current: null, groupCode: null, subscriptions: []}` |
| Service session expired (replaying an old service cookie) | `usage` → 401 with an empty body; `subscription` → 401 with `{"code":401}` |
| Account cookie rejected | The exchange stops at `account.xiaomi.com/fe/service/login` (HTML, 200) and mints no service cookies |
| No cookies at all | Same landing as the rejected case |

The rejected-account-cookie row is not hypothetical. Both lanes fail the same way: the membership chain lands on the login page, and the console answers `401` with a fresh `loginUrl`.

## Not verified

- **An active Console Token Plan response.** The active-plan values used in the mock matrix are controlled fixtures, not a live paid account; the public tier names do not establish the exact response shape of every subscription.
- **An active membership payload.** No plan was available, so only the no-subscription branch above is real. The *direction* of `percent` is settled (see Membership window), but not the values or extra fields a live plan returns.
- **The timezone of zoneless membership timestamps.** The app fixture carries no offset. Token Monitor keeps the console provider's existing UTC normalization so synced devices agree; a live active-membership response is still needed to confirm that instant.
- **Session effects of changing client headers.** Keep the measured header shape, but do not treat the earlier sign-out incident as proof that a missing `User-Agent` invalidates the session; that incident was later attributed to account removal by the user.
- **Long-term exchange tolerance is unknown.** Successful short probes and an unchanged local store do not establish server-side tolerance over days. The current implementation mints on refresh without a service-session cache and does not re-mint after a quota request's auth failure.
- **Windows on disk is unverified.** The measured install is macOS, where the cookie rows are plaintext. Whether a Windows install stores them in the clear or sealed is not known here — nothing about MiMo Desktop's Windows store has been observed. A required cookie available only as ciphertext, a missing SQLite capability or an unreadable store returns `unavailable`, retaining the last reading instead of clearing it; manual paste stays available. Linux has no local source because MiMo Desktop has no Linux build.

## Wiring

### Rows and identity

Console rows use the existing `hashKey("mimo:" + userId)` identity. An enabled saved credential wins for that account; Desktop discovery fills gaps and can add a different account beside it.

In Settings, a disabled saved Console credential does not hide a detected Desktop session for the same account: the disabled manual source and active local source are listed separately, while Limits still reports only the membership product.

The membership is that account's **second product**, so it gets a second row, keyed `hashKey("mimo:membership:" + userId)`. The two keys must differ: the hub collapses rows per account key (`aggregateLimits` → `pickBetterProvider`), so one key would publish one of the two products and drop the other — the reason `alibaba` separates its Team and Personal rows by variant. A Desktop session can publish this row for a current plan or a lane-specific failure; a successful no-plan answer omits it, and a machine with no Desktop session shows the console product alone.

On a full refresh, a Desktop logout or account switch explicitly removes vanished automatic identities. Omitting them is insufficient because the limits runtime retains missing identities as transient. The runtime consumes a **control row** — `{ provider, accountKey, removed: true }` — before normalization; one-shot collection drops it. It never reaches the device or Hub wire. Removal compares against the runtime's last accepted rows, so a superseded probe cannot consume it before commit. Scoped refreshes return only their selected product; removals wait for the next full refresh.

The two rows carry one account identity: the console profile name plus a short opaque suffix derived from the account key, or that suffix alone when the profile has no name. The console email is retained with that identity in the limits runtime's in-memory provider state, so a membership-only scoped refresh does not lose the association. A row collected before the suffix existed carries only its address: the grouping falls back to the address, and such a row groups apart from a suffix-named row until the collector rewrites it with the identity it derives from the account key — folding an anonymous row into a named one would merge two devices' accounts that merely share a mask.

Limits and Edge Dock reuse the provider heading and row layout. Healthy product rows identify themselves through Balance / Token Plan / Weekly and plan metadata; status-only rows carry `Console` / `Desktop Membership`, with the shared account-title fallback for legacy records. Multiple Xiaomi accounts add account headings and a logical account count. `mimoAccountGroups` groups by the identity suffix, then email, profile name and finally the row key.

Home, tray and widget snapshot use the product label for one logical account and `account · product` for several. The composer's account selector always includes the identity, following its existing account-selection behavior. The widget's shared layout prints row labels only when it has several snapshot rows; automatic selection may display fewer rows than the snapshot contains.

| Row | `accountLabel` (product identity) | `planLabel` | Source |
|---|---|---|---|
| Console | `Console` | the Token Plan name, else `Pay-as-you-go` | `web` + `managed` for a pasted credential, `local` + `app` for one minted from the machine |
| Desktop membership | `Desktop Membership` | `Starter` / `Plus` / `Pro` / `Ultra`; an unknown tier uses the vendor's `planCode` | `local` + `app` |

The membership has no plan to name when the subscription answers `current: null`, and the row is then **absent rather than empty** — a subscription the account does not have is not a row, which is the same rule the console lane follows for a Token Plan it cannot find (no plan, no window, nothing drawn). When a subscription ends, the row drops out of the response and the removal pass clears the identity it had published, so the last reading does not linger.

### Failure isolation

Each product carries its own status: an unauthorized membership can remain beside a healthy wallet. An unsupported account region has no membership endpoint, so it emits no membership row.

Limits uses the shared “Sign in again” status for rejected sessions, as it does for other Cookie-backed providers. Settings keeps one account-level row for a saved Console credential or a detected MiMo Desktop session and reuses that same shared status when the matching account-level row is rejected; a membership-only failure remains on its independent Limits row rather than creating a second Settings credential row. The manual form keeps its existing `settings.mimo.invalidCookie` detail for a Cookie rejected while saving. The source fields stay truthful (`web` + `managed` for a saved Console Cookie, `local` + `app` for the Desktop session).

When Desktop discovery is `notConfigured`, the provider emits no automatic row, so a working pasted Console account remains by itself. If there is no MiMo account at all, the shared Limits view may still show its enabled-provider `Not signed in` placeholder; that is the common view fallback, not a fabricated Desktop reading.

### Session reader

The local reader returns `{userId, cookieHeader}` or throws a status-bearing error, following the `readClineSession` convention. The provider catches it so discovery failure does not fail other accounts:

| Store state | Answer |
|---|---|
| Unsupported platform or no store | `notConfigured` — silence, and the user pastes instead |
| Store exists but cannot be inspected or opened, no `node:sqlite`, or a required cookie available only in `encrypted_value` | `unavailable` — transient, so the Limits runtime retains last-good automatic rows without removal markers |
| Readable and carrying **one** of the two cookies | `unauthorized` when `userId` identifies the account; without `userId`, a lone Desktop source shows `Sign in again`, while a pasted Console account remains alone rather than counting an unknown Desktop account |
| Readable and carrying **neither** | `notConfigured` — an app nobody has signed into is the same answer as no app |

At-rest encryption is a property of the store, never evidence that the user signed out.

Once the store can be read again, the next accepted refresh replaces the transient reading. The shared runtime's retry cooldown still applies. A confirmed logout or account switch continues to remove the vanished automatic identities.

### Transport

`deps.fetch` walks the chain hop by hop, which needs a fetch that can read a redirect's `Location` and its `Set-Cookie` without following it. undici can — on every runtime the headless agent and the hub use, and in the widget when a proxy environment variable is set. Chromium's `net.fetch` cannot: it answers a `redirect: 'manual'` request with `net::ERR_ABORTED`, and it is the widget's transport whenever no proxy environment variable is set, which is the normal case for a GUI app.

The walk therefore takes `deps.mimoExchangeFetch` when a runtime supplies one. In the widget, an explicit `HTTP(S)_PROXY`/`ALL_PROXY` environment keeps the same precedence and `NO_PROXY` behavior as every other limits request; otherwise the adapter asks Chromium what the OS/PAC configuration resolved for each host (`session.resolveProxy`, e.g. `PROXY 127.0.0.1:7890; DIRECT`) and routes undici through those routes in order. The adapter is `src/electron/providers/mimo/exchangeFetch.js`, injected beside `claudeWebFetch` into both the collector's deps and the settings probes'. A proxy type undici cannot speak is refused unless Chromium supplied a later usable fallback; every hop is cancellable, so a probe deadline stops the walk instead of waiting for it.

The cookie jar stays this module's either way. A Chromium *session* is not an alternative: it owns the cookie policy, and that policy withholds every cookie on the https→http hop this chain's callback makes.

The exchange jar identifies cookies by name, domain and path. Missing or invalid Path uses the issuing URL's directory; requests match on a path boundary, with longer paths first. `Max-Age` takes precedence over `Expires`, and deletion or expiry is applied both on redirect requests and when returning the minted credential. Attribute parsing uses undici, with local handling of URL-dependent default paths and negative `Max-Age`, which its parser does not provide. The jar exists only for one exchange; it is neither persisted nor written back to the Desktop partition.

### Manual console credential

`mimoManagedAccounts`, its settings panel, its cookie allowlist, its account keys and its windows remain the stored console contract. Minting adds a credential *source* beside it; it does not replace, migrate or re-key saved accounts. The membership lane stays under the existing `mimo` provider and has **no manual entry**: the console cookie cannot mint a membership session because the service ids differ (see Session exchange).

- **Console credential.** One Cookie covers the wallet and Token Plan endpoints. The existing form requires `api-platform_serviceToken` and `userId`; inference keys do not satisfy it.
- **Membership credential.** The machine's own Desktop session, read on every refresh and never stored. No shape of it is accepted from the settings panel.
- Saving validates with a read-only probe and keeps only allowlisted names. Discovered credentials and minted sessions are never saved, and nothing is written back to MiMo Desktop.
- A scoped refresh executes only the selected product lane. Saving or refreshing a console credential therefore does not spend the Desktop account cookie on an unrelated membership exchange; a membership refresh likewise does not call the console.

## Verification

Run the MiMo limits, credential and presentation tests when changing this note's scope:

```bash
node --test tests/shared/mimo*.test.js tests/electron/mimoExchangeFetch.test.js
```

`tests/shared/mimoLimits.test.js` covers the existing console contract; `tests/shared/mimoDesktopLimits.test.js` covers the two-lane composition and exchange classification with injected responses, and the local reader with a temporary SQLite store plus failure fixtures; neither suite reaches MiMo. `tests/electron/mimoExchangeFetch.test.js` covers the widget's transport, including a real CONNECT proxy.
