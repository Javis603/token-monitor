---
summary: "Cline notes: the shared ~/.cline data tree, the ClinePass quota read and its credential boundary, and the cache convention that under-counts token totals."
read_when:
  - Changing Cline token tracking, session metadata, or source roots
  - Changing the ClinePass usage-limits request or its credential resolution
  - Debugging Cline quota windows, stale sign-ins, or missing sessions
---

# Cline provider

Cline appears in Token Monitor in two independent data planes. Keep them separate when changing or debugging the provider.

| Data plane | What it measures | Primary runtime | Inputs |
| --- | --- | --- | --- |
| Token/session activity | Model-token activity attributed to Cline | Shared usage collector through `tokscale` | `~/.cline/data/sessions/`, plus the VS Code extension's `tasks/` globalStorage |
| Limits/quota | ClinePass five-hour, weekly, and monthly subscription windows, the account credit, and the month spend | Shared limits runtime | `GET https://api.cline.bot/api/v1/users/me/plan/usage-limits`, `/api/v1/users/{id}/balance`, `/api/v1/users/{id}/usages/daily` |

## One data tree, two front-ends

Cline Desktop and the Cline CLI write the same `~/.cline/data` tree. Each session document records
`source` as `cli` or `desktop`, but nothing downstream branches on it: tokscale's Cline CLI parser
reports both as the client id `cline`, and Token Monitor tracks one Cline row for the two. Do not
split them into separate ids. The client id is also a watch-attribution key, so a second id over the
same files would clear one partition and write another on every targeted scan.

`settings/providers.json` in that tree is the account's sign-in file, and it is what the limits
provider reads. Finding sessions does not authenticate the account API: a session directory can
exist with the sign-in removed or expired, which is the state this provider reports as
`unauthorized` rather than as missing data.

## Credentials resolve in one order

1. A `clineApiKey` provider option outranks the environment, then `CLINE_API_KEY`, then
   `CLINEPASS_API_KEY`. The settings field is what supplies that option, and the key it saves goes to
   the credential store (`providers.cline.apiKey`) rather than to `settings.json`; the two
   variables remain the surface for deployments with no UI.
2. The stored Cline sign-in in `settings/providers.json`. Cline keeps two provider sections there,
   and the ClinePass selection writes its credentials into the `cline` entry as well ("cline-pass
   stores under \"cline\"", `apps/vscode/src/sdk/auth-service.ts`), so `cline` is read first and
   `cline-pass` only as a fallback for a file an older version wrote. Reading them the other way round
   would let a stale entry mask the current credential.

Neither covers everyone, which is why both exist: a machine without Cline installed has no sign-in to
read, and the file is what makes the provider work with no setup at all for anyone actually running
Cline. A key is created on the account dashboard at `app.cline.bot/dashboard/account`. The public
documentation's "Settings → API Keys" does not resolve for a personal account — `/dashboard/settings`
and `/dashboard/settings/api-keys` both answer 404, and the dashboard's own `api-keys` section is an
organization page behind the `dashboard_api_keys_enterprise` feature flag — which is why the key lane
was reached by URL rather than through navigation. **Verified live**: a key authenticates this
endpoint and is rejected when prefixed, the exact opposite of the stored sign-in. Cline's own CLI
hands `ClineAccountService` the `cline` provider's persisted credential — the access token when one
exists, the API key otherwise (`getPersistedProviderApiKey()` →
`ClineProviderAuthHandler.getApiKey()`) — and its authentication reference documents API key and
account auth token as the two methods for the same `Authorization: Bearer` header.

A missing store and a signed-out one are reported differently, the distinction `readCodexOAuthAuth`
draws in `providers/codex`: no `providers.json` (or one that cannot be parsed) is `notConfigured`,
while a file that reads and holds no access token is `unauthorized`. Both name the `oauth` lane as the
source they failed on.

The two are **exclusive**, in the sense `docs/providers/volcengine.md` fixes for the same situation:
a configured key owns the lane, and a rejected key is reported instead of falling back to the stored
sign-in. Even an unusable explicit credential blocks the fallback, because quietly switching
credentials would show a different account's quota than the one the user configured. Each lane also
reports its own provenance: `api` for a configured key, `oauth` for a discovered sign-in — the split
`docs/providers/zai.md` states for its console key versus its discovered credential.

The order here is deliberately not Cline's. Inside one of its own provider settings Cline prefers the
stored access token and treats the API key as the fallback; this provider puts the environment key
first because that value is Token Monitor's own operator instruction, while the file is another
application's store, and the repository resolves credentials that way everywhere. Do not "fix" this
into the vendor's order: it would silently ignore a key the user configured for this machine.

Reading another application's credential file follows the existing local-discovery boundary: a
readable provider-owned configuration file may supply an in-memory credential
(`docs/providers/droid.md`, issue #586 precedent). Nothing is decrypted here — the file is plaintext
JSON — and Token Monitor persists no Cline credential of its own, so a manually supplied key exists
only for the process that read it.

The stored sign-in is read **only**, which is where Cline's own implementation draws the line: its
token response may carry a replacement refresh token (`toClineCredentials` takes
`responseData.refreshToken` when present) and its auth service writes the rotated access token, refresh
token, expiry and account id back to `providers.json` itself (`writeClineCredentials`, on any credential
change). Refreshing from here would mean discarding a replacement token and leaving Cline holding one
the server has retired — breaking a sign-in in another application to save a step Cline performs by
itself. So the stored token is sent as it stands: Cline refreshes it the next time it runs, a token that
has expired is refused by the account API and reported as `unauthorized` rather than healed here, and
nothing in this provider writes to that file. An expired sign-in therefore costs exactly one request —
the usage call, never a refresh.

The token goes out in the stored form, `workos:<jwt>`. Verified live against the endpoint:
`Bearer <bare jwt>` is rejected with 401 while `Bearer workos:<jwt>` authenticates. A user-supplied API
key is a different credential and is sent exactly as configured, since the mirror image holds —
`Bearer <key>` authenticates and `Bearer workos:<key>` is rejected.

Path resolution mirrors `cline_cli_session_roots` in tokscale's `scanner.rs`, the same precedence the
collector's session roots use: `CLINE_SESSION_DATA_DIR`, `CLINE_DATA_DIR`, then `CLINE_DIR`, each
winning outright. There is deliberately no fallback to `~/.cline` past a relocation, which would
report whichever account happens to be signed in at the default location.

The account identity is hashed from Cline's server-issued account id. A configured key stands for
itself. The access token is never used for this — it is replaced hourly, and an identity that rotates
would reach the hub as a new account on every ingest. A sign-in with no account id keeps no
`accountKey` instead of inventing one.

A Cline installation that lives only inside WSL is not read: `providers/claude/limits.js` has a
`wslClaudeCredentialPaths()` for the same situation, and the equivalent for Cline — a
`\\wsl$\\<distro>\\home\\<user>\\.cline\\data\\settings\\providers.json` candidate behind the same
Windows gate — is not implemented. The usage side still counts those sessions, because the Windows
collector scans WSL distros for token usage.

## What the quota read can show

The endpoint answers with one `five_hour`, `weekly`, and `monthly` entry per account, each carrying
`percentUsed` and an optional `resetsAt`; those map to the shared `session`, `weekly`, and `billing`
windows. The shape is confirmed by Cline's own dashboard client and by the three implementations
above; the request path itself is verified live as far as an account without a subscription allows —
the development account authenticates and is answered `404 {"error":"no plan history found for
user","success":false}`. That answer means there are no ClinePass windows to show, exactly like the
`limits: []` an empty plan returns — and when the account holds credit, that credit is the reading the
row shows instead of no data at all.

One limit is deliberate and is not a defect to be fixed here:

- **The free-model allowance is not readable.** `cline-free/*` models enforce a daily per-model cap
  that appears only in the body of the 429 refusing the call. No endpoint reports it, so no window is
  shown for it.

What the account holds instead of a subscription is readable, and is read: `GET
/api/v1/users/{id}/balance` answers `{"data":{"userId":"…","balance":500000},"success":true}`, and
500000 is the `Credits: 0.5000` Cline's own account page prints — its dashboard divides by 1e6 before
displaying, so the value is micro-credits. It is reported as a `credits` window (`label: 'Credits'`,
`currency: 'CREDITS'`, `remaining`, no meter), which `limitBalanceDisplay` prints as a bare amount
beside the label, the same convention WorkBuddy's credit balance uses. The endpoint is keyed by the
user id and ownership-checked — another user's id answers `403 can only access own resources` — so it
is queried with the id belonging to the credential in use: the stored sign-in carries `accountId`,
while a key-only install reads `/api/v1/users/me` first, which is the one extra request a scan costs
there. The credit read is **best effort**: a
balance endpoint that is down or answers nonsense leaves the plan windows alone, and a rejected
balance call never turns the row into a credential problem. It is also what keeps a planless account
from reading as `unavailable` — with a credit in hand the row is `ok`, the rule
`docs/providers/zai.md` states for a key without a subscription.

What the account has **spent** is a second read: `GET
/api/v1/users/{id}/usages/daily?startdate=YYYY-MM-DD&enddate=YYYY-MM-DD` (the range is the local month
to date) answers `{"data":{"items":[{"date","aiModelName","promptTokens","completionTokens","costUsd",
"operation"}]},"success":true}`, and its `costUsd` values sum to the month's spend. That is reported as
a `spend` window — `{metric: 'spend', label: 'Usage credits', used, limit: null, showMeter: false}` —
deliberately separate from the credit rather than folded into it as a percentage, because the balance is
credits and this report is dollars: the meter derivation would otherwise mix two units into a number
that means nothing. The window shape is Claude's ("money already consumed"), the line it draws is the
one WorkBuddy's `Spend` row shows, and the meter stays off because no monthly cap is reported — the same
rule commandcode's purchased top-up and Claude's credit pool follow. It is best effort like the balance
read and **absent when the month recorded nothing**, so an account with no usage keeps the shorter scan:
the plan, the balance and the usage report with a local sign-in, plus the profile read that yields the
account id on a key-only install.

### Parsing rules

No live windows payload has been observed from this repository, so the mapping below was matched field
by field against payloads other ClinePass clients captured rather than observed here.

| Rule | Here |
| --- | --- |
| `data.limits[]` with `five_hour` / `weekly` / `monthly`, reported in that order | fixed `WINDOW_ORDER` |
| an unknown window type is skipped; the known ones survive it | skipped — this repository's window vocabulary is closed, so an unknown type has no representable kind anyway |
| a `type` that is present but is not a string voids the reading | voided; an absent or blank one is skipped instead |
| a `type` that is a string is normalized before it is matched | trimmed and lowercased |
| `resetsAt: null` keeps the window | kept |
| a `resetsAt` that is present but is not a parseable timestamp voids the reading | voided; an absent or blank one keeps the window without a reset time |
| a percentage that is present but not numeric voids the reading | voided |
| a window with no `percentUsed` at all is left out | dropped, and the windows that carry one are still reported |
| 401 → credential problem, 429 → rate limited, anything else (403 and 5xx included) → unavailable | `unauthorized`, `sourceRateLimited`, `unavailable` |
| percentages clamp to 0–100 | clamped, deliberately **not rounded**: the shared burn-rate math reads the raw value |

Three deliberate choices, recorded so they are not "corrected" later:

- **The monthly window is labelled, not timed.** A `billing` window is this repository's catch-all kind
  and carries `label: 'Monthly'` (Kimi's and Command Code's monthly windows, Claude's credit windows),
  while `windowMinutes` belongs to the two fixed-duration kinds.
- **`CLINE_API_KEY` is read before `CLINEPASS_API_KEY`.** They are aliases of one key, the vendor-named
  one is read first, and the order only matters when both are set to different values.
- **A `resetsAt` that is a number is read as an epoch.** The acceptance comes from
  `providerHelpers.toIso`, a reader shared by every provider in this repository and asserted in
  `tests/shared/limitsProviderHelpers.test.js`. It reads `1` as 1970 — a real date rather than a
  rejection, which is the cost of sharing that reader instead of adding a stricter one here.

An account without a subscription answers `limits: []`, which is reported as no data rather than as a
live zero. One line runs through every field: a value that is **present but wrong** is a broken contract
and voids the whole reading, because reporting the rest would show a quota that silently lost a window,
while a value that is **absent** is tolerated. So a percentage that is present but not numeric voids the
reading, a `resetsAt` that is present but not a parseable timestamp does the same, a `type` that is
present but not a string does too, and an **unrecognized window type** skips only that row — the last is
not a broken field but a window this repository cannot name, so a window Cline adds later cannot take the
reading down. What "absent" then means differs per field: a window with no percentage is **left out of
the report**, while a window with no `resetsAt` is kept without a reset time. Both spellings (`resetsAt`,
`resets_at`) are read, and the guards validate the value that was actually read rather than one spelling
of it.

## Token totals under-count cache-heavy rows

Cline stores the upstream provider's own usage convention in `metrics.inputTokens`, and the two
conventions disagree: OpenAI-style rows include cached tokens in `inputTokens`, Anthropic-style rows
exclude them. tokscale normalizes for the first and subtracts cache reads unconditionally, so rows
where `cacheReadTokens > inputTokens` lose those cache reads from the total and can drive the input
column negative. On the machine this provider was written against, that is 401 of 15,668 Cline
messages and about 3.6% of the reported Cline volume, concentrated in the free and ClinePass model
families.

This is upstream tokscale's arithmetic, not Token Monitor's. It lives in `sessions/cline.rs` in the
pinned release (`scripts/vendor/tokscale.json`), it reproduces identically on upstream's own published
4.17.0 binary and on this fork's vendored build, and nothing here adjusts Cline token totals: the
shared extractors read the report that parser produces. A fix therefore belongs to the pinned source
upstream, not to this folder.

## Source map

| Concern | Files |
| --- | --- |
| Tracked client, source roots, watch | `src/shared/clientCatalog.js`, `clientSourceRoots()` in `src/shared/collector.js` |
| Limits provider and its credential read | `src/shared/providers/cline/limits.js` |
| Provider registration | `src/shared/limitProviders.js`, `providerFetchers()` in `src/shared/limits/collector.js` |
| Settings surface | account group + key field in `src/electron/renderer/index.html` and `app.js`; `settings.cline.*` in `i18n.js`; `clineApiKey` in `LIMIT_PROVIDER_SETTING_KEYS` and `CREDENTIAL_SETTING_PATHS` |

Run focused tests while iterating, then finish with `npm run sync:worker` when shared Worker files
changed, `npm run update:hub-build`, `npm run verify`, and `git diff --check`.

A live check needs a credential, not necessarily Cline: `CLINE_API_KEY` or `CLINEPASS_API_KEY` in the
environment is enough on any machine, while the stored sign-in needs Cline to have been signed in at
some point. It is always one request — the usage call — whether a key or a stored sign-in supplied the
credential:

```bash
node -e "require('./src/shared/providers/cline/limits').fetchClineLimits().then(r => console.log(r.status, JSON.stringify(r.windows)))"
```
