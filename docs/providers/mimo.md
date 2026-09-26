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

MiMo appears in Token Monitor in two independent planes. Keep them separate: they share a product name and nothing else.

| Plane | What it measures | Runtime | Credential |
|---|---|---|---|
| Token usage | Local `mimocode` SQLite via tokscale, reported under the `mimo` tracked client | collector | none (reads the engine's own store) |
| Limits — platform console | Open-platform wallet balance, Token Plan credit and reported spend | limits | console session, mintable from the machine's account cookie (or pasted by the user) |
| Limits — Desktop membership | The Xiaomi-account membership quota from the current subscription | limits | MiMo Desktop's own account cookie, exchanged on demand (below) |

The tracked client keeps its own identity rules: MiMo Code and MiMo Desktop are one row (`tokscaleClientMapping.js` maps both onto `mimo`), and the colour is black, not Xiaomi orange — both decided upstream (#772 / #775).

Every endpoint, path and field below is read from the app's own bundle rather than guessed. What was observed live was observed on one macOS install, on an account with no membership.

## Credentials and exchange

Two hosts and four endpoints are involved. Every path below is from the app's own code, not guessed.

| Purpose | Request | Notes |
|---|---|---|
| Account identity | `GET {base}/user/xiaomi/me` | The exchange driver (see below). Success is `code === 0` with `data.userId` |
| Membership usage | `GET {base}/user/usage` | `{percent, resetDate}` — the app never renders it (see Membership window) |
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

The hop through `/api/sts` is what **mints the service session**, and the cookie jar gains `serviceToken`, `mimopc_ph`, `mimopc_slh`, `passInfo`, `pass_ua` and `deviceId`. The service id is `mimopc`, and the login is driven by visiting the API — the app carries no URL that constructs it.

- **Exchange-minted service cookies stay in memory.** They are this exchange's output, and the membership lane's only credential is the account cookie it was minted from: the account cookie is read again on every refresh, and nothing minted here is stored.
- **A service cookie is not a substitute for the identity hop.** Measured: a freshly minted `serviceToken` set answers `/user/xiaomi/subscription/self` and `/user/usage` with `code: 0`, and is answered by `/user/xiaomi/me` with a **302 back to the SSO**, so it carries no identity and no region reading. Nothing else needs that distinction today — the lane has no paste — but the console lane's service cookie is a different service's and would not work here either.
- **The account cookie uses a 30-day sliding server window.** An accepted exchange re-issues `passToken`, but Token Monitor discards the refreshed value and never writes it back. The reader is read-only, repeated exchanges leave the partition unchanged, and a row Chromium has purged becomes the normal silent fallback. An absolute server-side lifetime is not known.
- **The exchange is silent while the account cookie is valid.** When it is rejected, the chain stops at `account.xiaomi.com/fe/service/login` and **mints nothing** — the refusal signature, detectable with no interactive step.
- The final followup was observed as `http://`, answering 200 with a `/sts` token not marked `Secure`. Do not force HTTPS on it: a `Secure` cookie is withheld from an `http:` hop.
- **The account session is one named partition**, `persist:xiaomi-account`. The app sets `X-Client-Version` and `X-Mimo-Source` on those requests; **neither is required and nothing may key on either** — their values vary by build.
- **Every request the walk makes is shaped like a MiMo client** — the header set `providers/mimo/browserHeaders.js` defines. Its `Origin` and `Referer` go to the console host alone: those name the console page, the console's own web UI sends them and the app's calls send neither, so a hop to the SSO carrying them is a shape no real client has. See Not verified: getting the client shape wrong does not merely fail the request.
- **Redirects are allowlisted per hop.** HTTPS may stay on the original service host or move through Xiaomi login domains; HTTP is accepted only for that service host's observed `/sts` or `/api/sts` callback. Cookies remain host/domain scoped and `Secure` cookies are withheld from HTTP.
- The walk's transport is chosen at the **runtime boundary** like every other provider call; see Transport.

### Account cookie on disk

`~/Library/Application Support/Xiaomi MiMo/Partitions/xiaomi-account/Cookies` — the app's own Electron partition, the one its login window uses. A Chromium SQLite cookie store, so the read is a read-only `DatabaseSync` open, the shape `readCursorDesktopAccessToken` already establishes for another app's store.

macOS is measured. Windows uses Electron's documented `%APPDATA%` location under the same `Xiaomi MiMo` product root, but remains unverified on disk. Linux discovery is disabled until a shipped storage layout is verified; it falls back to the existing manual console-cookie flow.

Two facts about its **contents** are load-bearing, both measured:

- **The account cookies are host-scoped, and the host is `.account.xiaomi.com`** — `passToken` and `userId` each exist on that host only. `.xiaomi.com` carries its own `cUserId`, so **selecting by cookie name alone is ambiguous**. `.xiaomimimo.com` cookies have never been present, because the service session is minted rather than stored.
- **The partition is not only MiMo's.** The same store holds unrelated third-party login cookies, so the read must be scoped to the account host rather than sweeping the store, and **anything forwarded must come from an exact allowlist** — the rule `providers/commandcode` states, that everything outside the session-cookie allowlist is a credential the endpoint has no business receiving.

On the measured machine every row is **plaintext** (`value` populated, `encrypted_value` empty), so no keychain read is involved. An unreadable or encrypted store is a state the implementation reports, not an error.

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

That mints `api-platform_serviceToken`, `api-platform_ph`, `api-platform_slh`, `deviceId`, `passInfo`, `pass_ua` and `ptn_count` — the first being one of the two names the console lane requires. With that session, all five console reads answer `code: 0`: `/balance`, `/userProfile`, `/tokenPlan/detail`, `/tokenPlan/usage` and `/usage`.

`/usage` is the only console summary that reports spend. `costUsage.totalCost` is all-time money spent and `currentMonthCost` is the month figure shown by the row. It has no daily or weekly rollup, so those values stay absent. The paginated call ledger and monthly bill endpoint are intentionally not queried.

The wallet itself reports money only: `{balance, frozenBalance, currency, overdraftLimit, remainingOverdraftLimit, giftBalance, cashBalance}` — no cap and no percentage of its own. The meter the row draws beside it is therefore **derived at display time** (`amount / (amount + monthSpend)`, `creditsMeterPercent` in `src/shared/limitBalanceDisplay.js`), the same display-layer rule deepseek's and openrouter's balances follow, and never a wire value.

Both lanes therefore resolve the same way: an account cookie already on the machine, exchanged per refresh for a session that is never stored. The console lane keeps the manual paste as its fallback where no MiMo Desktop is signed in; the membership has none, because it is not sold on the developer platform.

### API keys

An `sk-` key authorises inference and nothing else: every billing-shaped path on its host answers 404, and the console API refuses a Bearer token outright (`401 {"code":401,"loginUrl":…}`). There is no key-facing quota surface to find. **A key is an inference credential here, never a quota credential.**

## Response contracts

### Membership window

`/user/usage` has a strict parser in the app and the app never calls it: nothing reads its result. Its contract is pinned here — the endpoint is live and may be wired later — but **no rendered behaviour can be derived from it**, and its `percent` direction has no rendering evidence.

**What the user sees comes from `/user/xiaomi/subscription/self`.** The billing panel reads `current.percent` into a progress bar (`width: min(percent, 100)%`) and a `remainingPercent` string, and `current.nextResetTime` into the reset line, under a section titled "general usage limit" and one card titled "weekly usage limit" — a heading and a card title, not two quotas.

- The percentage is therefore a **remaining** share on a 0–100 scale, not the platform console's used-ratio. Do not reuse the console lane's normalisation.
- **Judge plan state by `current` being absent, never by `percent`.** The app's own test is the loose one (`t == null`), so a payload that omits `current` is the same answer as one that states it as null.
- **There is exactly one window.** Nothing in the app reads a second one.

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

Token Monitor reports no current plan as an `ok` membership row with no quota window. That clears a previous meter without putting a normal no-plan answer into the transient retry path.

Plan names follow the app's current-plan card:

```
source === 'INVITE'   -> no current-plan label; usage still renders
planTier ∈ [1, 4]     -> the tier name from the app's billing.planTier map
otherwise             -> the vendor's planCode
```

The tier map is `{1: Starter, 2: Plus, 3: Pro, 4: Ultra}` (the app's `zh` locale translates the same four). The app joins a renewal mode onto the name for its own sidebar; a limits row carries one plan label, so the renewal mode is not part of it.

### Account classifier

This is the exchange's driver *and* its verdict, so the lane's "is this session good" answer comes from here rather than from any status code on the quota endpoints.

Success is exactly `code === 0` **and** a non-empty `String(data.userId)` — the app's own test. Anything else is not a session, and *which* refusal it is decides the status the row carries:

| Observation | Status |
| --- | --- |
| body `code` is `403` or **`46109`**, the HTTP status is one of those, or it is 401 | `unauthorized` |
| 429 | `sourceRateLimited` |
| the chain ended on the account host instead of the service | `unauthorized` |
| a 200 that is not the answer, or any other failure | `unavailable` |

So a 500 reads as an outage rather than a signed-out app, and a body-level `46109` is a refusal without the code itself being carried any further.

`46109` is Xiaomi's own auth code and is not an HTTP status — it is why a MiMo refusal can arrive as a perfectly ordinary 200 and still mean the session is gone. The classifier also carries the account's `region`, which is what selects the base URL. A region the app does not carry has no host at all, so the membership lane goes quiet for one; an **absent** region is not evidence of a foreign account — there the call proceeds and the endpoint answers for itself.

**The account id must come from the server-issued `userId`, never from a rotating token.** A minted console session's fresh cookies do not include one, so the id the account cookie already carries is passed through — the same value `/userProfile` reports.

## Live signatures

| State | What the endpoints answer |
|---|---|
| Valid account cookie, no membership | `me` → `code=0` with `userId`; `usage` → `code=0` `{percent: 0.0, resetDate: null}`; `subscription` → `code=0` `{current: null, groupCode: null, subscriptions: []}` |
| Service session expired (replaying an old service cookie) | `usage` → 401 with an empty body; `subscription` → 401 with `{"code":401}` |
| Account cookie rejected | The exchange stops at `account.xiaomi.com/fe/service/login` (HTML, 200) and mints no service cookies |
| No cookies at all | Same landing as the rejected case |

The rejected-account-cookie row is not hypothetical. Both lanes fail the same way: the membership chain lands on the login page, and the console answers `401` with a fresh `loginUrl`.

## Not verified

- **An active membership payload.** No plan was available, so only the no-subscription branch above is real. The *direction* of `percent` is settled (see Membership window), but not the values or extra fields a live plan returns.
- **The timezone of zoneless membership timestamps.** The app fixture carries no offset. Token Monitor keeps the console provider's existing UTC normalization so synced devices agree; a live active-membership response is still needed to confirm that instant.
- **A request with the wrong client headers may invalidate the account session.** This was observed after omitting `User-Agent`, so the exchange keeps the measured header shape. A normally rejected credential did not have the same effect.
- **The long-term exchange tolerance is unknown.** Controlled bursts well above the shipped five-minute cadence completed cleanly and left the partition byte-identical. If production evidence later justifies fewer exchanges, cache minted sessions in memory and re-mint on 401; do not persist them.
- **Windows on disk.** The measured install is macOS, where the cookie rows are plaintext. Chromium normally seals Windows cookies with DPAPI, so those rows may arrive sealed; the provider reports that as `notConfigured` and falls back silently. Linux discovery is intentionally unsupported until its packaged path and cookie representation are verified.

## Wiring

### Rows and identity

Every console credential names one account, keyed as `hashKey("mimo:" + userId)` — the key `mimoAccountKey` already computed for the console lane. A pasted console cookie, a saved account and the session this machine's own MiMo Desktop mints are therefore **three credentials for one identity, not three rows**, and discovery needs no precedence rule: a credential the user entered occupies its own account's entry, and the machine's session fills only the entries still empty.

The membership is that account's **second product**, so it gets a second row, keyed `hashKey("mimo:membership:" + userId)`. The two keys must differ: the hub collapses rows per account key (`aggregateLimits` → `pickBetterProvider`), so one key would publish one of the two products and drop the other — the reason `alibaba` separates its Team and Personal rows by variant. The row exists only when the machine has a Desktop session (see Failure isolation); a machine with none shows the console product alone.

If the Desktop account signs out or changes while a pasted Console account still answers, the provider explicitly removes the vanished automatic row identities. Omitting them is insufficient because the limits runtime treats a missing identity in a mixed response as transient and retains its last good quota. The removal is a **control row** — `{ provider, accountKey, removed: true }`, carrying no reading — that `collectLimitsOnce` and the runtime's `commitRows` consume and that is stripped before normalization, so it never reaches a device record or the wire. It is the one row this provider emits that is an instruction rather than a reading.

The two rows carry one account identity: the console profile name plus a short opaque suffix derived from the account key, or that suffix alone when the profile has no name. The console email is retained with that identity in the limits runtime's in-memory provider state, so a membership-only scoped refresh does not lose the association. Limits, tray selectors and the native widget render `account · product`; multiple Xiaomi accounts remain distinguishable even when the profile endpoint has no email.

| Row | `accountLabel` (product) | `planLabel` | Source |
|---|---|---|---|
| Console | `Console` | the Token Plan name, else `Pay-as-you-go` | `web` + `managed` for a pasted credential, `local` + `app` for one minted from the machine |
| Desktop membership | `Desktop Membership` | `Starter` / `Plus` / `Pro` / `Ultra`; an unknown tier uses the vendor's `planCode` | `local` + `app` |

The membership has no plan to name when the subscription answers `current: null`; the row still appears, with no weekly window, and the plan cell says **`No active plan`** — the app's own string for that state.

### Failure isolation

Each row carries its own lane's answer, so a lane that failed takes its own row's status instead of speaking through the other product's row. A membership whose session ended is an `unauthorized` membership row beside a live wallet row; before the split, both shared one row and the failure had to be smuggled in beside a wallet that was still true. A region the app's table does not carry resolves no membership endpoint at all, so that row is absent rather than mislabelled.

The renderer reads which recovery to name off the row's own `sourceDetail` (`app` → sign in to MiMo Desktop again, `managed` → replace the pasted Cookie), which is also why `sourceDetail` has to stay truthful per row.

### Session reader

The local reader follows the existing `readClineSession` result shape:

| Store state | Answer |
|---|---|
| Unsupported platform, no store, no `node:sqlite`, **sealed rows** | `notConfigured` — silence, and the user pastes instead |
| Store exists but cannot be inspected or opened | `unavailable` — transient, so the Limits runtime retains last-good automatic rows |
| Readable and carrying **one** of the two cookies | `unauthorized`, attributed to `userId` when present and otherwise provider-scoped, telling the user to sign in to MiMo Desktop again |
| Readable and carrying **neither** | `notConfigured` — an app nobody has signed into is the same answer as no app |

At-rest encryption is a property of the store, never evidence that the user signed out.

### Transport

`deps.fetch` walks the chain hop by hop, which needs a fetch that can read a redirect's `Location` and its `Set-Cookie` without following it. undici can — on every runtime the headless agent and the hub use, and in the widget when a proxy environment variable is set. Chromium's `net.fetch` cannot: it answers a `redirect: 'manual'` request with `net::ERR_ABORTED`, and it is the widget's transport whenever no proxy environment variable is set, which is the normal case for a GUI app.

The walk therefore takes `deps.mimoExchangeFetch` when a runtime supplies one. In the widget, an explicit `HTTP(S)_PROXY`/`ALL_PROXY` environment keeps the same precedence and `NO_PROXY` behavior as every other limits request; otherwise the adapter asks Chromium what the OS/PAC configuration resolved for each host (`session.resolveProxy`, e.g. `PROXY 127.0.0.1:7890; DIRECT`) and routes undici through those routes in order. The adapter is `src/electron/providers/mimo/exchangeFetch.js`, injected beside `claudeWebFetch` into both the collector's deps and the settings probes'. A proxy type undici cannot speak is refused unless Chromium supplied a later usable fallback; every hop is cancellable, so a probe deadline stops the walk instead of waiting for it.

The cookie jar stays this module's either way. A Chromium *session* is not an alternative: it owns the cookie policy, and that policy withholds every cookie on the https→http hop this chain's callback makes.

### Manual console credential

`mimoManagedAccounts`, its settings panel, its cookie allowlist, its account keys and its windows remain the stored console contract. Minting adds a credential *source* beside it; it does not replace, migrate or re-key saved accounts. The membership lane stays under the existing `mimo` provider and has **no manual entry**: the console cookie cannot mint a membership session because the service ids differ (see Session exchange).

- **Console credential.** One paste covers the wallet and the Token Plan: both answer to the same session, which is why the four console endpoints share one allowlist. Nothing separate is needed for a Token Plan, and no `sk-` or `tp-` key could add it (see API keys).
- **Membership credential.** The machine's own Desktop session, read on every refresh and never stored. No shape of it is accepted from the settings panel.
- Saving validates with a read-only probe and keeps only allowlisted names. Discovered credentials and minted sessions are never saved, and nothing is written back to MiMo Desktop.
- A scoped refresh executes only the selected product lane. Saving or refreshing a console credential therefore does not spend the Desktop account cookie on an unrelated membership exchange; a membership refresh likewise does not call the console.

## Verification

Run the MiMo limits, credential and presentation tests when changing this note's scope:

```bash
node --test tests/shared/mimo*.test.js tests/electron/mimoExchangeFetch.test.js
```

`tests/shared/mimoLimits.test.js` is the provider's suite — the console lane's parsers and allowlist, the two-lane composition, the exchange's classification and the local reader's refusals — run against an injected world that walks both real chains, so nothing in it reaches MiMo. `tests/electron/mimoExchangeFetch.test.js` covers the widget's transport, including a real CONNECT proxy.
