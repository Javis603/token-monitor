---
summary: "Cline notes: the shared ~/.cline data tree, the ClinePass quota read and its credential boundary, and the cache convention that under-counts token totals."
ids: [cline]
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

Cline Desktop and the CLI write the same `~/.cline/data` tree. Sessions record `source: cli|desktop`
and nothing branches on it: tokscale reports both as the client id `cline`, and Token Monitor tracks one
row. Do not split them — that id is a watch-attribution key, so a second one over the same files would
clear one partition and write another on every targeted scan.

`settings/providers.json` in that tree holds the account sign-in, which is what the limits read uses.
Finding sessions does not authenticate the account API: a directory can sit there with the sign-in
removed or expired, which is reported as `unauthorized` rather than as missing data.

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

A machine without Cline has no sign-in to read, which is why the key lane exists. Keys are created at
`app.cline.bot/dashboard/account`; the documented "Settings → API Keys" path 404s for a personal account,
so this URL rather than navigation. **Verified live**: a key authenticates here and is rejected when
prefixed, the mirror image of the stored sign-in.

A missing store and a signed-out one are reported differently, the distinction `readCodexOAuthAuth`
draws in `providers/codex`: no `providers.json` (or one that cannot be parsed) is `notConfigured`,
while a file that reads and holds no access token is `unauthorized`. Both name the `oauth` lane as the
source they failed on.

The lanes are **exclusive**, the rule `docs/providers/volcengine.md` fixes for the same situation: a
configured key owns the lane and a rejected key is reported rather than falling back, since quietly
switching would show a different account's quota. Each names its provenance — `api` for a key, `oauth`
for a sign-in, the split `docs/providers/zai.md` states.

Both refusals report the same shared `unauthorized` status, so the status pill reads that provenance to
name the credential to fix: `api` renders "Update API key" (the field this application owns) and
`oauth` renders "Open Cline". This is the only provider whose pill branches on `source`, and it does so
because neither cause is the rarer one — the file lane is the discovery default while its access token
expires hourly — so any single label would be wrong for the state a fresh install is in.

The order is deliberately not Cline's, which prefers the stored token: the key comes first because it is
Token Monitor's own operator instruction while the file is another application's store, and the
repository resolves credentials that way everywhere. Do not "fix" this into the vendor's order — it
would silently ignore a key the user configured for this machine.

Reading another application's credential file follows the existing local-discovery boundary: a
readable provider-owned configuration file may supply an in-memory credential
(`docs/providers/droid.md`, issue #586 precedent). Nothing is decrypted here — the file is plaintext
JSON — and nothing read from it is written back: the discovered sign-in lives in memory for the scan.
A key **configured** in Token Monitor is a different thing, and it goes to Token Monitor's own
credential store (`providers.cline.apiKey`, never `settings.json`), not into Cline's file.

The sign-in is read **only**. Cline's token response may carry a replacement refresh token and its auth
service persists the rotated credential itself (`toClineCredentials`, `writeClineCredentials`), so
refreshing here would leave Cline holding a token the server has retired. The stored token is sent as it
stands instead: Cline refreshes it next time it runs, and an expired one is refused as `unauthorized`. An
expired sign-in costs exactly one request, never a refresh.

The token goes out in the stored form, `workos:<jwt>`. Verified live against the endpoint:
`Bearer <bare jwt>` is rejected with 401 while `Bearer workos:<jwt>` authenticates. A user-supplied API
key is a different credential and is sent exactly as configured, since the mirror image holds —
`Bearer <key>` authenticates and `Bearer workos:<key>` is rejected.

Path resolution mirrors `cline_cli_session_roots` in tokscale's `scanner.rs`, the same precedence the
collector's session roots use: `CLINE_SESSION_DATA_DIR`, `CLINE_DATA_DIR`, then `CLINE_DIR`, each
winning outright. There is deliberately no fallback to `~/.cline` past a relocation, which would
report whichever account happens to be signed in at the default location.

The identity is hashed from Cline's server-issued account id, or from the key itself. The access token
is never it: that one is replaced hourly, and a rotating identity would reach the hub as a new account on
every ingest. A sign-in whose file carries no id takes the one the profile read answers, which is also
where the row's display email comes from; only when neither names an account is there no `accountKey`,
rather than an invented one.

That makes identity per lane, so one account reached by key on one machine and by sign-in on another
lists as two. `providers/zai` has the same shape. Merging them would need `accountKeyAliases`, which
`limits/core.js` gates to opencode — widening the shared Hub core for one provider.

A Cline that lives only inside WSL is not read: `providers/claude/limits.js` has
`wslClaudeCredentialPaths()` for the same case, and the Cline equivalent is not implemented. Usage is
unaffected — the Windows collector scans WSL distros for tokens.

## What the quota read can show

The endpoint answers one `five_hour`, `weekly` and `monthly` entry per account, each with `percentUsed`
and an optional `resetsAt`, mapped to the shared `session`, `weekly` and `billing` windows. The rolling
window is shown as **5-hour**, the vendor's own name for it (its ClinePass page lists "5-hour rolling
window", "Weekly", "Monthly"), which is the rule `src/shared/limitWindowLabels.js` applies to a vendor
that publishes its names. That mapping rests on two sources that agree: the public ClinePass clients,
which name the request and the three window types, and the generated API client inside Cline's own
dashboard bundle, whose limit entry carries exactly `percentUsed`, `resetsAt` and `type`. The path itself
is verified live as far as an account with no subscription allows, which is the 404 `no plan history
found for user`. That answer means there are no ClinePass windows to show, exactly like an empty
`limits: []` — and with credit in hand, the credit is the reading.

**The free-model allowance is not readable.** `cline-free/*` models carry a daily per-model cap that no
endpoint reports: Cline's own clients read it out of the 429's message text (`isClineFreeModelLimitMessage`
in `@cline/core`), and the user API reference lists no counter. Nothing can be shown until Cline exposes
one.

The account's credit is readable, and read: `/api/v1/users/{id}/balance` answers micro-credits, so
`balance: 500000` is the `Credits: 0.5000` the account page prints. It is reported as a `credits` window
(`label: 'Credits'`, `currency: 'CREDITS'`, no meter), printed as a bare amount beside the label, the
convention WorkBuddy's balance uses. The endpoint is keyed by user id and ownership-checked, so it is
queried with the id belonging to the credential in use: the stored sign-in carries it, while a key-only
install asks `/api/v1/users/me` first — the plan call is first in both lanes, and this is the one extra
request that lane costs. The read is **best effort**: a balance endpoint that is down or answers nonsense
leaves the plan windows alone, and a rejected balance call is never a credential problem. It is also what
keeps a planless account from reading as `unavailable` — with credit in hand the row is `ok`, the rule
`docs/providers/zai.md` states.

The grants behind a balance are readable at `/promotions` and are deliberately **not** a window: a ledger
answers where the money came from, not what is left.

That rule covers the planless answers only. A plan read that fails otherwise keeps its own status while
the credit is read either way: the lanes are independent the way `providers/zai` builds its quota and
balance lanes, where an error decides the status and never the data a healthy request returned. An outage
is therefore visible without costing the account its balance line. The one exception is the credential —
every request carries the same token, so a refusal ends the scan, which is also why an expired sign-in
costs one request. What a transient status shows is the retained last reading (`lastGood` /
`lastAttempt`, `src/shared/limits/runtime.js`); an account with nothing behind it yet shows nothing.

The **spend** is a second read, from `/api/v1/users/{id}/usages/daily?startDate=…&endDate=…` (the range
is the local month to date), summing `costUsd` into a `spend` window —
`{metric: 'spend', label: 'Usage credits', used, limit: null, showMeter: false}`. It stays separate from
the credit because the balance is credits and this report is money; folding them would mix two units. The
shape is Claude's, the line is WorkBuddy's `Spend` row, and the meter stays off because no cap is reported
— the rule commandcode's purchased top-up and Claude's credit pool follow. It is best effort like the
balance read, and absent when the month recorded nothing, so an account with no usage shows no line.
Both parameter names are the vendor client's, down to their casing: the generated client in Cline's
dashboard bundle sends `startDate` and `endDate` and marks both required. The lowercase spelling answers
the same range live — this API ignores case — so the vendor's form is kept as the contract's own rather
than because the other one fails.

`costUsd` is hundred-millionths of a dollar. The ledger pins it: one row carries `creditsUsed` 23649 and
`costUsd` 2364975 for the same charge, so a µ-credit is a micro-dollar and 1e8 units make a dollar.
**Verified live**: three paid calls and two free ones left the day's paid rows at `$0.03246637` while the
balance moved `0.5 → 0.4675`, the difference being whole µ-credits per call — each ledger row rounds its
`costUsd` down to the µ-credit (`2364975 → 23649`, `668843 → 6688`, `212819 → 2128`), which is why the
balance and the summed report differ in the last digits.

Free-tier rows are skipped for the same reason the balance never moves for them: a `cline-free/kimi-k3`
call answers a would-be price (`costUsd` 2179200) with nothing charged, and counting it would report
money nobody paid. Either spelling the report carries marks the tier — the `cline-free/…` model id and
`aiModelTypeName: 'cline-free'` — because the vendor's own rule is the id prefix
(`CLINE_FREE_MODEL_PREFIX`), and a renamed id would otherwise quietly start counting free usage as spend.

**The report is not in the vendor's public API reference and carries no pagination fields**, so a heavy
month could be cut short without anything here noticing; the cross-check above is all this provider has
for it. The vendor's own client agrees on the second half — the `/users/{id}/usages/daily` method takes
`startDate` and `endDate` and nothing else, and maps a response of `{items}` with no cursor — while the
endpoint the public reference does document, `/users/{id}/usages`, takes a `cursor` and a `limit` and
answers `nextToken` and `total`: that is the ledger rather than the aggregate, at one request per page.

### Parsing rules

No live windows payload has been observed here, so the mapping below was matched field by field against
two sources that agree: the fixtures the public ClinePass clients carry — CodexBar's
`ClinePassPluginTests` and CodeBurn's `quota-clinepass.test.ts`, which are two readings of one contract
rather than one lineage, since CodeBurn credits CodexBar as prior art for the endpoints and response
shapes while calling its own adapters an independent implementation — and the generated client Cline's own
dashboard bundle ships, whose limit entry is exactly `{percentUsed, resetsAt, type}`.

| Rule | Here |
| --- | --- |
| `data.limits[]` with `five_hour` / `weekly` / `monthly` | fixed `WINDOW_ORDER`; a repeated type keeps the last |
| an unknown window type | skipped — the repository's window vocabulary is closed, so it has no representable kind |
| a `type` that is present but not a string | voided; an absent or blank one is skipped |
| a `type` that is a string | trimmed and lowercased before it is matched |
| a `resetsAt`/`percentUsed` present but unparseable | voided; an absent or blank one is tolerated |
| percentages clamp to 0–100 | clamped, deliberately **not rounded**: the shared burn-rate math reads the raw value |
| 401 → credential problem, 429 → rate limited, anything else (403 and 5xx included) → unavailable | `unauthorized`, `sourceRateLimited`, `unavailable` |

Five deliberate choices, recorded so they are not "corrected" later:

- **A lane error decides the status and nothing else**, told apart from the planless answers by the
  HTTP status `limits/providerHelpers.js` keeps for exactly that reason.
- **A `403` is not read as a credential problem** until this API is seen answering one: only 401 and the
  plan-less 404 have been observed here. CodexBar (`authenticationExpired`) and CodeBurn (a terminal
  credential failure) do read 403 as one, but that is their reading of this endpoint, not an observation.
- **The monthly window is labelled, not timed**: a `billing` window is this repository's catch-all kind.
- **`CLINE_API_KEY` is read before `CLINEPASS_API_KEY`**, two aliases of one key, where the order only
  matters when both are set to different values.
- **A numeric `resetsAt` is read as an epoch** by the shared `providerHelpers.toIso`, which reads `1` as
  1970 — the cost of sharing that reader instead of adding a stricter one here.

An account without a subscription answers `limits: []`, reported as no data rather than as a live zero.
One line runs through the table: **present but wrong voids the reading, absent is tolerated**. What
absent means differs per field — a window with no percentage is left out, one with no `resetsAt` is kept
without a reset time — and an **unrecognized window type** skips only its own row, so a window type
Cline adds later cannot invalidate the readings around it. Both spellings of both fields
(`percentUsed`/`percent_used`, `resetsAt`/`resets_at`) are read, and the guards validate the value
actually read rather than one spelling of it.

## Token totals under-count cache-heavy rows

Cline stores the upstream provider's own usage convention in `metrics.inputTokens`, and the two
conventions disagree: OpenAI-style rows count cached tokens there, Anthropic-style rows do not. tokscale
normalizes for the first and subtracts cache reads unconditionally, so a row with
`cacheReadTokens > inputTokens` loses them and can drive the input column negative. On the machine this
was written against that is 401 of 15,668 Cline messages, about 3.6% of the volume, concentrated in the
free and ClinePass families.

This is tokscale's arithmetic, not this repository's: it lives in `sessions/cline.rs` of the pinned
release (`scripts/vendor/tokscale.json`), reproduces on both the published 4.17.0 binary and this fork's
build, and nothing here adjusts token totals. A fix belongs upstream.

Run focused tests while iterating, then finish with `npm run sync:worker` when shared Worker files
changed, `npm run update:hub-build`, `npm run verify`, and `git diff --check`.

A cancelled probe is **propagated, not reported as a status**: the caller's `deps.signal` is checked
before any request and after each read, so a superseded or shutting-down scan rejects with an
`AbortError` instead of describing an outage that never happened, and stops rather than spending the
requests that follow. The check after a read is the one that carries it, because a cancellation does not
survive one: the shared transport hands an aborted request back as its own `unavailable` timeout
(`limits/providerHelpers.js`), so it reaches the caller as an ordinary failed read. That is also why
this provider asks the signal there instead of rethrowing by name the way `providers/zed` and
`providers/alibaba` do inside their best-effort catches — by the time the catch runs, the name is gone.

A live check needs a credential, not necessarily Cline: `CLINE_API_KEY` or `CLINEPASS_API_KEY` in the
environment is enough on any machine, while the stored sign-in needs Cline to have been signed in at
some point. The first request is always the plan usage call, and a credential that call refuses is the
whole answer — an expired sign-in costs exactly that one request. A credential it accepts is followed by
the balance and then the month-to-date usage report: three requests in all from a stored sign-in, four
from a key, which has to learn its account id first:

```bash
node -e "require('./src/shared/providers/cline/limits').fetchClineLimits().then(r => console.log(r.status, JSON.stringify(r.windows)))"
```
