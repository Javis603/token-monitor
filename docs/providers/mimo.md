---
summary: "MiMo notes: the two data planes (tokscale token usage vs the limits provider), the platform console lane the provider already had, and the Desktop membership lane — an account cookie exchanged through the Xiaomi SSO for an ephemeral service session, plus the parsers and failure signatures that were verified live."
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
| Limits — platform console | Open-platform wallet balance and Token Plan credit | limits | console session, mintable from the machine's account cookie (or pasted by the user) |
| Limits — Desktop membership | The Xiaomi-account membership quota from the current subscription | limits | MiMo Desktop's own account cookie, exchanged on demand (below) |

The tracked client keeps its own identity rules: MiMo Code and MiMo Desktop are one row (`tokscaleClientMapping.js` maps both onto `mimo`), and the colour is black, not Xiaomi orange — both decided upstream (#772 / #775).

Every endpoint, path and field below is read from the app's own bundle rather than guessed. What was observed live was observed on one macOS install, on an account with no membership.

## 1. The Desktop membership chain

Two hosts and four endpoints are involved. Every path below is from the app's own code, not guessed.

| Purpose | Request | Notes |
|---|---|---|
| Account identity | `GET {base}/user/xiaomi/me` | The exchange driver (see below). Success is `code === 0` with `data.userId` |
| Membership usage | `GET {base}/user/usage` | `{percent, resetDate}` — the app never renders it (§2.1) |
| Subscription | `GET {base}/user/xiaomi/subscription/self` | `{groupCode, current, subscriptions}` |
| Logout | `{base}/user/xiaomi/logout` | What the app calls when the user signs out; revokes server-side **and** clears the partition's cookies |

`{base}` is `https://mimo-server-cn.xiaomimimo.com/api`, built by the app as `https://${host}/api` from a region table whose **only entry is CN**. The app can name other regions — it maps a country list onto IN/RU/EU/SGP — but the lookup returns **null** for all of them, so a non-CN account resolves no base URL and the membership lane cannot run for it.

This build is the domestic edition: `editionDefault` and `fallbackRegion` are CN and `requiresCnAccount` is `true`, which makes the app **revoke** a login whose account region is not CN, and a `KR` account unconditionally. The region is the *account's*, not the network's: an account registered in mainland China answers CN from anywhere.

### 1.1 Authentication is an exchange, not a stored token

The session is established by following a redirect chain with the **account** cookie present:

```
GET {base}/user/xiaomi/me
  -> 302 account.xiaomi.com/pass/serviceLogin?callback=…/api/sts?sign=…&followup=…/api/user/xiaomi/me&sid=mimopc
  -> 302 {base}/sts                 (silent: passToken accepted, no login page)
  -> 307 {base}/user/xiaomi/me
  -> 200 {"code":0, "data":{"userId": …}}
```

The hop through `/api/sts` is what **mints the service session**, and the cookie jar gains `serviceToken`, `mimopc_ph`, `mimopc_slh`, `passInfo`, `pass_ua` and `deviceId`. The service id is `mimopc`, and the login is driven by visiting the API — the app carries no URL that constructs it.

Consequences worth keeping:

- **Exchange-minted service cookies stay in memory.** They are this exchange's output; the account cookie is read again on every refresh. A service cookie the user pastes is a separate fallback credential, kept until cleared.
- **A service cookie is not a substitute for the identity hop.** Measured: a freshly minted `serviceToken` set answers `/user/xiaomi/subscription/self` and `/user/usage` with `code: 0`, and is answered by `/user/xiaomi/me` with a **302 back to the SSO**. A pasted service cookie therefore goes straight to the subscription read, and the `userId` the paste carries is its identity — routing it through the exchange's own identity check would refuse a credential that works. It also carries no region reading, since only `/me` reports one.
- **The exchange is silent while the account cookie is valid.** When it is rejected, the chain stops at `account.xiaomi.com/fe/service/login` and **mints nothing** — the refusal signature, detectable with no interactive step.
- The final followup was observed as `http://`, answering 200 with a `/sts` token not marked `Secure`. Do not force HTTPS on it: a `Secure` cookie is withheld from an `http:` hop.
- **The account session is one named partition**, `persist:xiaomi-account`. The app sets `X-Client-Version` and `X-Mimo-Source` on those requests; **neither is required and nothing may key on either** — their values vary by build.
- **Every request the walk makes is shaped like a MiMo client** — the header set `providers/mimo/browserHeaders.js` defines. See §4: getting this wrong does not merely fail the request.
- The walk's transport is chosen at the **runtime boundary** like every other provider call; see §5.3.

### 1.2 Where the account cookie lives

`~/Library/Application Support/Xiaomi MiMo/Partitions/xiaomi-account/Cookies` — the app's own Electron partition, the one its login window uses. A Chromium SQLite cookie store, so the read is a read-only `DatabaseSync` open, the shape `readCursorDesktopAccessToken` already establishes for another app's store.

The app ships on all three desktop platforms, so each candidate is Electron's rule for that platform rather than a guess: `%APPDATA%` (then Roaming under the home directory) on Windows, `$XDG_CONFIG_HOME` or `~/.config` on Linux, Application Support on macOS — all under the `Xiaomi MiMo` root the app's `productName` gives. macOS is the one measured; a wrong path elsewhere reads nothing, the same silent answer as no store.

Two facts about its **contents** are load-bearing, both measured:

- **The account cookies are host-scoped, and the host is `.account.xiaomi.com`** — `passToken` and `userId` each exist on that host only. `.xiaomi.com` carries its own `cUserId`, so **selecting by cookie name alone is ambiguous**. `.xiaomimimo.com` cookies have never been present, because the service session is minted rather than stored.
- **The partition is not only MiMo's.** The same store holds unrelated third-party login cookies, so the read must be scoped to the account host rather than sweeping the store, and **anything forwarded must come from an exact allowlist** — the rule `providers/commandcode` states, that everything outside the session-cookie allowlist is a credential the endpoint has no business receiving.

On the measured machine every row is **plaintext** (`value` populated, `encrypted_value` empty), so no keychain read is involved. An unreadable or encrypted store is a state the implementation reports, not an error.

Two cookies are load-bearing: dropping **`passToken`** or **`userId`** stops the exchange at the login page and mints nothing, while dropping `cUserId` changes nothing.

### 1.3 The app's own login predicate is not a validity test

The app decides "signed in" by cookie **names** (`passToken` | `serviceToken` | `*_serviceToken` | `*_ph`). It is not domain-aware and says nothing about whether the endpoints answer.

Discovery must therefore treat name-matching as *presence only* and let the exchange decide *validity*.

### 1.4 The platform console mints the same way

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

That mints `api-platform_serviceToken`, `api-platform_ph`, `api-platform_slh`, `deviceId`, `passInfo`, `pass_ua` and `ptn_count` — the first being one of the two names the console lane requires. With that session, all four console reads answer `code: 0`: `/balance`, `/userProfile`, `/tokenPlan/detail`, `/tokenPlan/usage`.

Both lanes therefore resolve the same way: an account cookie already on the machine, exchanged per refresh for a session that is never stored. The manual paste remains the fallback where no MiMo Desktop is signed in.

### 1.5 No API key can read a balance

An `sk-` key authorises inference and nothing else: every billing-shaped path on its host answers 404, and the console API refuses a Bearer token outright (`401 {"code":401,"loginUrl":…}`). There is no key-facing quota surface to find. **A key is an inference credential here, never a quota credential.**

## 2. Response contracts

### 2.1 The membership window is the subscription, not `/user/usage`

`/user/usage` has a strict parser in the app and the app never calls it: nothing reads its result. Its contract is pinned here — the endpoint is live and may be wired later — but **no rendered behaviour can be derived from it**, and its `percent` direction has no rendering evidence.

**What the user sees comes from `/user/xiaomi/subscription/self`.** The billing panel reads `current.percent` into a progress bar (`width: min(percent, 100)%`) and a `remainingPercent` string, and `current.nextResetTime` into the reset line, under a section titled "general usage limit" and one card titled "weekly usage limit" — a heading and a card title, not two quotas.

- The percentage is therefore a **remaining** share on a 0–100 scale, not the platform console's used-ratio. Do not reuse the console lane's normalisation.
- **Judge plan state by `current` being absent, never by `percent`.** The app's own test is the loose one (`t == null`), so a payload that omits `current` is the same answer as one that states it as null.
- **There is exactly one window.** Nothing in the app reads a second one.

### 2.2 `/user/xiaomi/subscription/self` — validated in the renderer

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

**Plan names are the app's own mapping**, from the same pass over `current`:

```
source === 'INVITE'   -> "INVITE"
planTier ∈ [1, 4]     -> the tier name from the app's billing.planTier map
otherwise             -> no name
```

The tier map is `{1: Starter, 2: Plus, 3: Pro, 4: Ultra}` (the app's `zh` locale translates the same four). The app joins a renewal mode onto the name for its own sidebar; a limits row carries one plan label, so the renewal mode is not part of it.

### 2.3 `/user/xiaomi/me` — the account classifier

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

## 3. Signatures observed live

| State | What the endpoints answer |
|---|---|
| Valid account cookie, no membership | `me` → `code=0` with `userId`; `usage` → `code=0` `{percent: 0.0, resetDate: null}`; `subscription` → `code=0` `{current: null, groupCode: null, subscriptions: []}` |
| Service session expired (replaying an old service cookie) | `usage` → 401 with an empty body; `subscription` → 401 with `{"code":401}` |
| Account cookie rejected | The exchange stops at `account.xiaomi.com/fe/service/login` (HTML, 200) and mints no service cookies |
| No cookies at all | Same landing as the rejected case |

The rejected-account-cookie row is not hypothetical. Both lanes fail the same way: the membership chain lands on the login page, and the console answers `401` with a fresh `loginUrl`.

## 4. Not verified

- **An active membership payload.** No plan was available, so only the no-subscription branch above is real. The *direction* of `percent` is settled (§2.1), but not the values or extra fields a live plan returns.
- **A request that does not look like a MiMo client costs the user their session.** A request with no `User-Agent` was followed by the same cookie answering the login page to every client until the user signed in again. A refused credential is not what ends one: exchanging an empty `passToken` was followed by a refresh with the real cookie answering as usual.
- **How much exchanging a session tolerates is not established.** One long run of well-shaped exchanges was harmless, but session losses have also coincided with heavy exchange traffic — including a widget left running, which spends the account cookie on both lanes every refresh (`limitsRefreshMs`, 5 minutes by default). The walk's volume is a cost to watch rather than a proven-free operation, and the lever if it ever needs to come down is to cache the minted session in memory and re-mint when it answers 401 instead of minting on every tick.
- **Repeated minting is non-destructive to local state.** Repeat cycles leave the partition byte-identical, so nothing is written back. Whether the app is running is likewise irrelevant: the cookie is on disk and the exchange is an HTTP walk.
- **Windows and Linux on disk.** The measured install is macOS, where the cookie rows are plaintext. Chromium seals its cookie store by default on the other two (DPAPI, the OS keyring) and nothing in the app's bundle disables that, so their rows may arrive sealed — which this provider reports as `notConfigured` and falls back from silently. Which way it goes needs a machine.

## 5. How the provider is wired

### 5.1 One row per account

Every credential names one account, keyed as `hashKey("mimo:" + userId)` — the key `mimoAccountKey` already computed for the console lane. A pasted console cookie, a pasted membership session and the session this machine's own MiMo Desktop mints are therefore **three credentials for one identity, not three rows**: the row is the union of what its lanes answered. Discovery needs no precedence rule, because a credential the user entered occupies its own account's entry and the machine's session fills only the entries still empty.

The composition is the shape `providers/opencode` gives its two lanes: the console row is the base (it owns the wallet, the Token Plan and the plan label), the membership lane is supplemental, a lane that answered carries the row, and a lane that failed speaks only when nothing else answered — and only for a status a user can act on (`unauthorized`, `sourceRateLimited`, `unavailable`).

The plan column takes the membership tier when there is one, because a tier is a plan and the console's own label is a product. For a wallet-only account that product is **`Pay-as-you-go`** — the name `providers/deepseek` gives its balance-only row, and Xiaomi's own term for the `sk-` API side.

### 5.2 The local session reader refuses in two ways

The shape `readClineSession` establishes, and the fallback the owner asked for:

| Store state | Answer |
|---|---|
| Unsupported platform, no store, unreadable, no `node:sqlite`, **sealed rows** | `notConfigured` — silence, and the user pastes instead |
| Readable and carrying **one** of the two cookies | `unauthorized`, attributed to the `userId` it found, telling the user to sign in to MiMo Desktop again |
| Readable and carrying **neither** | `notConfigured` — an app nobody has signed into is the same answer as no app |

At-rest encryption is a property of the store, never evidence that the user signed out.

### 5.3 The walk's transport is the runtime's

`deps.fetch` walks the chain hop by hop, which needs a fetch that can read a redirect's `Location` and its `Set-Cookie` without following it. undici can — on every runtime the headless agent and the hub use, and in the widget when a proxy environment variable is set. Chromium's `net.fetch` cannot: it answers a `redirect: 'manual'` request with `net::ERR_ABORTED`, and it is the widget's transport whenever no proxy environment variable is set, which is the normal case for a GUI app.

The walk therefore takes `deps.mimoExchangeFetch` when a runtime supplies one, and the widget supplies the same request shape routed through whatever Chromium resolved for that host (`session.resolveProxy`, e.g. `PROXY 127.0.0.1:7890`). That adapter is `src/electron/providers/mimo/exchangeFetch.js`, injected beside `claudeWebFetch` into both the collector's deps and the settings probes'. A proxy type undici cannot speak is refused, not skipped; every hop is cancellable, so a probe deadline stops the walk instead of waiting for it.

The cookie jar stays this module's either way. A Chromium *session* is not an alternative: it owns the cookie policy, and that policy withholds every cookie on the https→http hop this chain's callback makes.

### 5.4 The pasted console lane does not move

`mimoManagedAccounts`, its settings panel, its cookie allowlist, its account keys and its windows are what users already have configured; minting is a new credential *source* beside it, never a replacement, a migration or a re-keying of what is saved. The membership lane belongs **under the existing `mimo` provider** — the maintainer ruled out a top-level `mimo-desktop` provider.

- **Console credential.** One paste covers both products: the wallet and the Token Plan answer to the same session, which is why the four console endpoints share one allowlist. Nothing separate is needed for a Token Plan, and no `sk-` or `tp-` key could add it (§1.5).
- **Membership credential.** Either shape is accepted, in this order: the **account cookie** (`passToken` + `userId`), which the exchange spends on every refresh and which does not rotate; or a **service cookie set** (`serviceToken` + optional `mimopc_ph` + `userId`), short-lived and read directly (§1.1). Anything else — including the console's `api-platform_serviceToken`, another service's — is refused at save time. Both shapes, and the console paste, were verified live against sessions minted on the machine.
- Saving validates with a read-only probe, keeps only allowlisted names, stores under `providers.mimo.membershipCookie` in `credentials.json`, reaches the renderer only as a configured flag, and clears from the same panel. Discovered credentials and minted sessions are never saved.
- A refused exchange is `unauthorized`, not a transient retry. The row sends a discovered account back to MiMo Desktop; a pasted credential stays for the user to replace or clear.

## Verification

Run the MiMo limits, credential and presentation tests when changing this note's scope:

```bash
node --test tests/shared/mimo*.test.js tests/electron/mimoExchangeFetch.test.js
```

`tests/shared/mimoLimits.test.js` is the provider's suite — the console lane's parsers and allowlist, the two-lane composition, the exchange's classification and the local reader's refusals — run against an injected world that walks both real chains, so nothing in it reaches MiMo. `tests/electron/mimoExchangeFetch.test.js` covers the widget's transport, including a real CONNECT proxy.
