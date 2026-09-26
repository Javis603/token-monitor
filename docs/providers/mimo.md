---
summary: "MiMo notes: the two data planes (tokscale token usage vs the limits provider), and the Desktop membership chain — an account cookie exchanged through the Xiaomi SSO (sid=mimopc, /api/sts) for an ephemeral service session, plus the parsers and failure signatures that were verified live."
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
| Limits — Desktop membership | The Xiaomi-account membership quota (usage + subscription) — **not implemented yet** | limits | MiMo Desktop's own account cookie, exchanged on demand (below) |

The tracked client keeps its own identity rules: MiMo Code and MiMo Desktop are one row (`tokscaleClientMapping.js` maps `micode` and `micode-desktop` onto `mimo`), and the colour is black, not Xiaomi orange — both decided in upstream #772 / #775.

Everything below was read from build `26.920.202101` and re-checked against `26.922.222056`: the usage parser, the subscription schema and the exchange wiring are identical between the two. What was observed live was observed on one macOS install with no membership on the account.

## 1. The Desktop membership chain

Two hosts and four endpoints are involved. Every path below is from the app's own code, not guessed.

| Purpose | Request | Notes |
|---|---|---|
| Account identity | `GET {base}/user/xiaomi/me` | The exchange driver (see below). Success is `code === 0` with `data.userId` |
| Membership usage | `GET {base}/user/usage` | `{percent, resetDate}` |
| Subscription | `GET {base}/user/xiaomi/subscription/self` | `{groupCode, current, subscriptions}` |
| Logout | `{base}/user/xiaomi/logout` | What the app calls when the user signs out; revokes server-side **and** clears the partition's cookies |

`{base}` is `https://mimo-server-cn.xiaomimimo.com/api`, built by the app as `https://${host}/api` from a region table whose **only entry is CN** (`{CN: "mimo-server-cn.xiaomimimo.com"}`). The app can name other regions — it maps a country list onto IN/RU/EU/SGP — but the lookup returns **null** for all of them, so a non-CN account resolves no base URL at all and the membership lane cannot run for it. Only CN was observed live, and the table is the reason: there is nothing else to reach.

### 1.1 Authentication is an exchange, not a stored token

The session is established by following a redirect chain with the **account** cookie present:

```
GET {base}/user/xiaomi/me
  -> 302 account.xiaomi.com/pass/serviceLogin?callback=…/api/sts?sign=…&followup=…/api/user/xiaomi/me&sid=mimopc
  -> 302 {base}/sts                 (silent: passToken accepted, no login page)
  -> 307 {base}/user/xiaomi/me
  -> 200 {"code":0, "data":{"userId": …}}
```

The hop through `/api/sts` is what **mints the service session**, and the cookie jar gains `serviceToken`, `mimopc_ph`, `mimopc_slh`, `passInfo`, `pass_ua` and `deviceId`. The service id is `mimopc`; the app's own source only contains the generic `sid=passport` login URL, so the service login is driven by visiting the API, not by a URL the app constructs.

Consequences worth keeping:

- **The service cookies are ephemeral by design — never persist them.** They are this exchange's output. Whatever we hold should be the account cookie (which is already on the machine) and we re-mint per refresh. `serviceToken` is scoped to the service host; nothing needs to be pasted by the user.
- **The exchange is silent while the account cookie is valid.** When it is rejected the chain stops at `account.xiaomi.com/fe/service/login` and **no service cookies are minted** — that is the `auth-expired` signature, and it needs no interactive step to detect.
- The final followup hop is `http://`, because the server's own callback says so. Do not force https on that hop.
- **The account session is one named partition**, `persist:xiaomi-account`, a literal in the app's own source, and every call above goes through it (`session.fromPartition(T_).fetch`). `X-Client-Version` is set on those requests from `app.getVersion()`, and `X-Mimo-Source` is added by the app's fetch wrapper, which also strips any `Authorization` header before sending. **Neither header is required by the membership endpoints**: identical results were observed with them, without them, and with a browser UA instead of the app's. The wrapper's `X-Mimo-Source` value is version-dependent — `mimocode-cli-free` in the build this was first read from, `mimocode-cli` / `mimocode-desktop` elsewhere in the 26.922 build — so nothing should key on it.
- **The wrapper's 401 renewal is narrower than "any 401".** It renews the login and retries once only when the response body is *not* the "this model is outside the key's allowed range" error; that 401 belongs to an API-key scope and must not be answered by re-authenticating the account. A renewal that fails calls the auth-lost hook and returns the 401 unchanged, so the caller sees the refusal rather than a silent retry.
- **Every request the walk makes is shaped like a MiMo client** — the same header set the console reads send, from `providers/mimo/browserHeaders.js`. See §4 for why that is a hard requirement rather than a politeness.
- **The login hosts are an allowlist, not a suffix guess**: `xiaomi.com`, `mi.com` and `miui.com`, https only, matched on the exact host or a `.`-prefixed subdomain. The app uses it to classify every URL the login window navigates to (exact `/me`, then `/pass/serviceLogin`, `/pass/sns`, `/pass/auth` and `/fe/service/login…` as login-flow, everything else as account-other or third-party).

### 1.2 Where the account cookie lives

`~/Library/Application Support/Xiaomi MiMo/Partitions/xiaomi-account/Cookies` — the app's own Electron partition, the same one its login window uses. It is a Chromium SQLite cookie store, so the read is a read-only `DatabaseSync` open, the shape `readCursorDesktopAccessToken` already establishes for another app's SQLite credential store.

Two facts about its **contents** are load-bearing, both measured:

- **The account cookies are host-scoped, and the host is `.account.xiaomi.com`** — `passToken` and `userId` each exist on that host only. `.xiaomi.com` carries a second `cUserId` beside its own rows, so **selecting by cookie name alone is ambiguous**: a name-only query returns two `cUserId` rows. `.xiaomimimo.com` cookies have never been present — not before a login, and not after a sign-out and back in — because the service session is minted rather than stored.
- **The partition is not only MiMo's.** The same store holds a full set of unrelated Tencent login cookies (`.qq.com`, `.ptlogin2.qq.com`, `.graph.qq.com`, `.xui.ptlogin2.qq.com`), so the app reuses this session for other logins. Two consequences follow, and neither is optional: the read must be scoped to the account host rather than sweeping the store, and **anything we forward must come from an exact allowlist** — the rule `providers/commandcode` states, that everything outside the session-cookie allowlist is a credential the endpoint has no business receiving.

On the machine this was verified against, all 13 rows were **plaintext** (`value` populated, `encrypted_value` empty, no `v10` prefix), so no OS keychain read is involved. That is one machine's shape and must not be assumed for other Chromium/Electron builds or platforms; an unreadable or encrypted store is a state the implementation has to report, not an error.

What is present changes while the app runs (a `.xiaomi.com` `uLocale` row appeared and later vanished on its own during these checks), so read the current rows rather than assuming a fixed set.

Two cookies are load-bearing: dropping **`passToken`** or **`userId`** stops the exchange at the login page and mints nothing, while dropping `cUserId` changes nothing. One account was present on the verified machine (one distinct value per cookie name); how a second account would be represented is unknown, so the lane must not assume a single identity.

### 1.3 The app's own login predicate is not a validity test

The app decides "signed in" by cookie **names**: `passToken` | `serviceToken` | `*_serviceToken` | `*_ph`. It is not domain-aware and says nothing about whether the endpoints answer. On the verified machine it reported a session as present while every service call returned 401 — because only the account cookie existed and no exchange had been run.

A discovery implementation must therefore treat name-matching as *presence only*, and let the exchange decide *validity*.

### 1.4 The platform console mints the same way

The console is a **different service on the same Xiaomi SSO**, and its session can be minted from the same account cookie — so the wallet and Token Plan do not have to be a copy-the-cookie-from-DevTools flow either.

The shape differs from the membership lane in one way: the console does **not** answer with a 302. It answers `401` with a JSON body carrying the login URL, and the client is expected to visit it:

```
GET https://platform.xiaomimimo.com/api/v1/balance
  -> 401 {"code": 401, "loginUrl": "https://account.xiaomi.com/pass/serviceLogin
            ?callback=https://platform.xiaomimimo.com/sts?sign=…&followup=…/api/v1/balance
            &sid=api-platform&_group=DEFAULT"}
visit loginUrl
  -> 302 https://platform.xiaomimimo.com/sts
  -> 307 <the original endpoint>
```

That mints `api-platform_serviceToken`, `api-platform_ph`, `api-platform_slh`, `deviceId`, `passInfo`, `pass_ua` and `ptn_count` — the first of which is one of the two names the existing provider requires. With the minted session, all four console reads answer `code: 0`: `/balance`, `/userProfile`, `/tokenPlan/detail`, `/tokenPlan/usage` (and `/apiKeys`, which lists the account's keys).

So both lanes resolve the same way — an account cookie that is already on the machine, exchanged per refresh for a service session that is never stored. The manual cookie paste stays as the fallback for a machine that has no signed-in MiMo Desktop.

### 1.5 No API key can read a balance

Probed with a live `sk-` key: the key authorises inference (`GET https://api.xiaomimimo.com/v1/models` → 200) and nothing else. Every billing-shaped path on that host answers a plain 404 — `/v1/me`, `/v1/balance`, `/v1/user/balance`, `/v1/usage`, `/v1/user/self`, `/v1/dashboard/billing/{subscription,usage,credit_grants}` and the New API / One API compatibility routes `/api/status` and `/api/usage/token/` — and a successful response carries no quota headers. The console API refuses a Bearer token outright: `401 {"code":401,"loginUrl":…}`.

The official documentation says quota, usage and expiry are read on the console page; that is not an omission, there is no key-facing surface. **A key is an inference credential here, never a quota credential** — do not wire the `thirdparty` New API adapter to a MiMo base URL expecting it to work.

## 2. Response contracts

### 2.1 The membership window is the subscription, not `/user/usage`

Two endpoints answer for the membership and **only one of them is rendered**.

`/user/usage` has a strict parser (`xse`) and an IPC channel, and the app never calls it. The store that would hold its result is not exported from its chunk, its `load()` is never invoked, and the only reference to it anywhere in the renderer is a `reset()` inside `logoutAll()`. Verified in both builds (`26.920.202101` and `26.922.222056`). Its contract is still pinned here — the endpoint is live and may be wired later — but **no rendered behaviour can be derived from it**, and in particular its `percent` direction has no rendering evidence at all:

```
percent    finite number, >= 0          otherwise "usage field percent is invalid"
resetDate  === null  -> throws no-data  "usage has no active subscription"
           anything else that is not a string (absent included) -> "usage field resetDate is invalid"
```

**What the user actually sees comes from `/user/xiaomi/subscription/self`.** The billing panel reads `current.percent` into the progress bar (`width: min(percent, 100)%`) and the `remainingPercent` string, and `current.nextResetTime` into the `resetWeekly` line, under a section titled "general usage limit" and one card titled "weekly usage limit" — a section heading and a card title, not two quotas.

- The percentage is therefore a **remaining** share on a 0–100 scale, not the platform console's used-ratio. Do not reuse the console lane's normalisation. This is settled by the app's own rendering rather than its label: the bar's fill width is the value itself and the same number is printed through the `remainingPercent` string, so nothing is inverted anywhere.
- **Judge plan state by `current` being null, never by `percent`.** `current: null` is the app's "no active subscription"; the `/user/usage` no-subscription response still carried a valid `percent` (`0.0` was observed), so a `percent === 0` check would render a false 0% meter.
- **There is exactly one window.** Nothing in the app reads a second one.

### 2.2 `/user/xiaomi/subscription/self` — validated in the renderer

There is **no parser in the main bundle**: the request is registered without one and its `data` is passed through as `unknown`. The renderer validates `data.current` against a schema whose first five fields are **required** — a `current` missing any of them throws, and the panel then renders its `failed` state rather than a partial plan:

```
planCode       string    required
planTier       integer   required
endTime        string    required
percent        number    required
nextResetTime  string    required
renewalMode    "MONTHLY" | "YEARLY" | "ONE_TIME" | null   optional
source         string | null                              optional
```

`current: null` means no current plan, and it is a normal answer, not a failure: the schema returns null and the panel shows its no-plan copy. A `current` that is an array is invalid. The envelope's `groupCode` is read nowhere and `subscriptions` is not read by the membership UI — only `current` matters. The E2E fixture in the bundle also carries `id`, `title`, `status`, `startTime` and `bizNo`; nothing reads them, so nothing should depend on them.

`source === "INVITE"` is excluded from being *the* current plan — the plan card falls back to its no-plan copy — while its `percent` and `nextResetTime` still drive the usage card. That is the app's shape; mirror it rather than folding INVITE into either branch.

The app's own failure taxonomy is one shared reader behind both account requests, and it is what the panel's error copy keys off:

| Observation | Kind |
| --- | --- |
| HTTP 401 | `auth-expired` |
| any other non-OK HTTP status | `failed` |
| HTTP OK but body `code !== 0` | `no-data` |
| a parse that throws | `failed` |
| no answer inside 10 s (an `AbortController` per request) | `failed` |

### 2.3 `/user/xiaomi/me` — the account classifier

This is the exchange's driver *and* its verdict, so the lane's own "is this session good" answer comes from here rather than from any status code on the quota endpoints.

Success is exactly `code === 0` **and** a non-empty `String(data.userId)`. Anything else is not a session:

| Observation | Reading |
| --- | --- |
| body `code` is `403` or **`46109`**, or the HTTP status is one of those | server-rejected, and the code is kept |
| any other non-200 status | not logged in |
| 200 with `code !== 0`, or with an empty/absent `data.userId` | not logged in |

`46109` is Xiaomi's own auth code and is not an HTTP status — it is why a MiMo refusal can arrive as a perfectly ordinary 200 and still mean the session is gone. The classifier also carries the account's `displayName` (the first non-empty of `nickname`, `nickName`, `name`, `displayName`, `userName`), `region`, `country` and an optional `userMark`; the region is what selects the base URL, and with only CN in that table a non-CN account has none.

Two details of the app's own reading are worth copying rather than re-deriving:

- **The app's status probe lets the transport follow the chain** (`redirect: 'follow'`) and reads the body as text. undici has no cookie jar, so the chain has to be walked by hand here — but the intent to follow is the app's, and forcing a single hop would see the 302 as the answer.
- **The account id is read from the session's cookies with empty values dropped** (`cookies.get({name: 'userId'})` then the first non-empty `value`). A cookie row that exists but is blank is absent, which is the same rule the partition reader applies.

While a login is being completed the app polls that classifier on a bounded ladder — 5 s, 15 s, 45 s, 120 s, then a 300 s cap — and stops as soon as the answer is anything other than indeterminate. That is the app's own detection cadence, not ours to run: a refused exchange is reported to the user, it is not retried in the background.

## 3. Signatures observed live

| State | What the endpoints answer |
|---|---|
| Valid account cookie, no membership | `me` → `code=0` with `userId`; `usage` → `code=0` `{percent: 0.0, resetDate: null}`; `subscription` → `code=0` `{current: null, groupCode: null, subscriptions: []}` |
| Service session expired (after sign-out, replaying the old service cookie) | `usage` → 401 with an empty body; `subscription` → 401 with `{"code":401}` |
| Account cookie rejected | The exchange stops at `account.xiaomi.com/fe/service/login` (HTML, 200) and mints no service cookies |
| No cookies at all | Same landing as the rejected case |

The rejected-account-cookie row is not hypothetical. It was first produced by tampering with `passToken`, and later occurred on its own after a session of successful exchanges — with the cookie still present in the partition and MiMo Desktop not running. Both lanes failed the same way: the membership chain landed on the login page, and the console answered `401` with a fresh `loginUrl`. See §4 for what is still unknown about that event.

## 4. Not verified

- **An active membership payload.** No plan was available, so only the no-subscription branch above is real. The *direction* of `percent` is settled (§2.1), but not the values or extra fields a live plan returns. Parse per §2 and keep the failure mode safe: a parse failure lands on `failed` and keeps the last good reading rather than inventing numbers.
- **A request that does not look like a MiMo client costs the user their session.** Three observations fit one rule and no other: thirteen consecutive exchanges were harmless; a deliberately invalid `passToken` was followed by the account being refused; and a freshly signed-in session was lost the first time a request went out with no `User-Agent` at all — after which the same cookie answered the login page to every client, including two independent implementations, until the user signed in again. Volume is not the variable; the shape of the request is. So every hop the walk makes carries the header set `providers/mimo/browserHeaders.js` defines, the same one the console reads already sent, and the requirement is a hard one: getting it wrong does not merely fail the request, it logs the user out of MiMo Desktop.
- **A token is not single-use, and the rotation is not a budget.** The SSO's `serviceLogin` hop answers 302 with two fresh `passToken` entries, both different from the copy in the partition, and we never write them back — but a freshly signed-in cookie minted successfully more than once and the thirteen-cycle record had the same shape, so neither the rotation nor the count is what ends a session. That correction is recorded because this note asserted the opposite for a while, on a correlation that the tamper probe above already explained.

- **Whether the app must be running.** Irrelevant to the read: the cookie lives on disk and the exchange is an HTTP walk, so a closed app changes nothing about discovery. It was not demonstrated end-to-end only because the credential was already being rejected by the time the app was closed.
- **Repeated minting is non-destructive to local state.** Around thirteen cycles left the partition byte-identical (same row count and value fingerprint), so nothing is written back and nothing is disturbed on disk. What minting does server-side is the previous bullet.
- **Windows and Linux.** Everything above was observed on one macOS install.

## 5. Design constraints for the pending source

- **The pasted-cookie console lane is the shipped path and its behaviour does not move.** `mimoManagedAccounts`, its settings panel, its cookie allowlist, its account keys and its windows are what users already have configured; minting is a new credential *source* beside it, never a replacement, a migration or a re-keying of what is already saved.
- The membership lane belongs **under the existing `mimo` provider** — the maintainer ruled out a top-level `mimo-desktop` provider — and it must not collide with the platform console lane's credential namespace or `accountKey` (`hashKey("mimo:" + userId)`).
- Account identity should come from the server-issued `userId` in the `/me` payload, not from a rotating token.
- Cookie replay across the redirect chain is required (`mimo-server-cn` → `account.xiaomi.com` → back, and the same for the console's `/sts` walk). undici has no cookie jar, so the chain has to be walked manually, or driven by an Electron session, which limits these lanes to the widget like the other local-discovery providers.
- A sign-out must not silently trigger the app's interactive renewal. The exchange either succeeds silently or is reported as expired.
- **A refused exchange is `auth-expired`, and that is the whole handling.** The remedy is one re-login in MiMo Desktop (or one re-paste), so nothing here needs to model a lifetime, refresh ahead of expiry, retry the walk repeatedly, or re-authenticate in the background. Treating it as a transient failure and retrying would only delay the prompt the user needs to see.

### 5.1 Credential precedence: configured wins, minting fills the gap

Both lanes resolve credentials in the same order, and it is the rule the provider code already states for Cline — "a key the user configured beats the sign-in Cline happens to have on this machine":

1. **A credential the user configured.** Minting never overwrites, replaces or shadows it; a user who pasted something chose it deliberately.
2. **Otherwise mint from the machine's account cookie**, when one exists. This is the zero-action path and what most machines with a signed-in MiMo Desktop will take.
3. **Otherwise report the lane as not configured** and leave the path to a pasted credential.

The paste input stays available in **all three** cases, not only the third, because it is also the recovery path when a discovered session misbehaves. A configured credential that keeps failing is the user's to replace, not ours to override; if it earns the UI, the failure line can point at the local session the way Cline's refusals carry source-specific recovery — an addition, not a requirement.

- **Console lane.** The existing `mimoManagedAccounts` cookie paste (and its settings panel) stays exactly as it is — minting is additive, not a replacement. One consequence has to be handled: a minted session and a pasted session for the **same account must collapse onto one identity**. `mimoAccountKey` prefers an explicit `account.userId` and otherwise reads the `userId` cookie, so the minted path — whose freshly minted cookies do **not** include `userId` — passes the id the account cookie already carries. That is the same server-issued `userId` `/userProfile` reports (the console's own front end reads it from `/userProfile` as `userId`), so no extra request is spent on it and the same account reached either way lands on one row.
- **Membership lane.** Accept either shape, in this order of preference:
  1. the **account cookie** (`passToken` + `userId`) — long-lived, and we run the exchange ourselves on every refresh. This is the one to put in the user-facing guidance, because it does not rotate.
  2. a **service cookie set** (`serviceToken` / `mimopc_ph` + `userId`) — usable directly without an exchange, but short-lived by design, so it will need re-pasting. Tolerated rather than recommended.
- Validation before saving follows the existing lane's rule: a read-only probe through the minted or pasted credential, and the credential lands in the local credential store under the provider's existing namespace — never in a log, the renderer, or the wire.
- The UI cost is real even without a toggle: a fallback needs somewhere to paste. The maintainer ruled out a separate *enable switch*, not an input, but the distinction is worth stating when the change is proposed.
