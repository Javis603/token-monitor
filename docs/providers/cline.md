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
| Limits/quota | ClinePass five-hour, weekly, and monthly subscription windows | Shared limits runtime | `GET https://api.cline.bot/api/v1/users/me/plan/usage-limits` |

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

1. `CLINE_API_KEY`, then `CLINEPASS_API_KEY`, then the provider options a manual field would supply.
2. The stored Cline sign-in in `settings/providers.json`.

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

A stored sign-in that has expired is **refreshed in memory** rather than left stale: the scan that
finds it calls `POST /api/v1/auth/refresh` with the stored refresh token and uses the result, so a
sign-in that went old while Cline was closed heals on the next refresh cycle. The refresh is
per-process cached and keyed by the refresh token, so a stale sign-in costs one refresh rather than
one per scan, and a different sign-in (a new refresh token) is refreshed again. It is never written
back: Cline's refresh endpoint returns the same refresh token it was given — verified live — so a
refresh here cannot invalidate Cline's own copy, and persisting into another application's
credential file would buy nothing the next scan does not redo.

Only a refresh the endpoint answers with an invalid grant is reported as `unauthorized` (the sign-in
itself is gone): that is a `401`/`403`, or a `400` whose body says so — the live endpoint answers
`{"error":"failed to refresh token: invalid_grant"}` for a bad token while an empty body is answered
`{"error":"Validation failed",...}`. Cline's own classifier (`isLikelyInvalidGrant`) draws the line
from the same signal. A validation failure and a transport failure are `unavailable`, so a transient
problem never tells the user to sign in again.

The token goes out in the stored form, `workos:<jwt>`. Cline's refresh endpoint answers with the bare
JWT, so the prefix is *added* for the wire rather than stripped: verified live against the endpoint,
`Bearer <bare jwt>` is rejected with 401 while `Bearer workos:<jwt>` authenticates. A user-supplied
API key is a different credential and is sent exactly as configured, since the mirror image holds —
`Bearer <key>` authenticates and `Bearer workos:<key>` is rejected.

Path resolution mirrors `cline_cli_session_roots` in tokscale's `scanner.rs`, the same precedence the
collector's session roots use: `CLINE_SESSION_DATA_DIR`, `CLINE_DATA_DIR`, then `CLINE_DIR`, each
winning outright. There is deliberately no fallback to `~/.cline` past a relocation, which would
report whichever account happens to be signed in at the default location.

The account identity is hashed from an identifier that survives a refresh: Cline's server-issued
account id, or the refresh token, which its endpoint returns unchanged. A configured key stands for
itself. The access token is never used for this — it is replaced hourly, and an identity that rotates
would reach the hub as a new account on every ingest. A sign-in with none of those identifiers keeps
no `accountKey` instead of inventing one.

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
user","success":false}`. That answer is reported as no data, exactly like the `limits: []` an empty
plan returns, because both mean the same thing: this account has no ClinePass windows to show.

Two limits are deliberate and are not defects to be fixed here:

- **The free-model allowance is not readable.** `cline-free/*` models enforce a daily per-model cap
  that appears only in the body of the 429 refusing the call. No endpoint reports it, so no window is
  shown for it.
- **Pay-as-you-go credits are not read.** `/api/v1/users/{id}/balance` is keyed by a user id
  `providers.json` does not carry, so reading it costs a second request per refresh.

### The success path is aligned to precedent, field by field

No live windows payload has been observed from this repository, so the mapping is
anchored on the three implementations that carry captured payloads rather than chosen
here:

| Rule | Pinned by | Here |
| --- | --- | --- |
| `data.limits[]` with `five_hour` / `weekly` / `monthly`, reported in that order | CodexBar's golden test asserts exactly those three; CodeBurn's fixture maps them in that order | fixed `WINDOW_ORDER` |
| an unknown window type is skipped; the known ones survive it | CodexBar's `unknown limits are ignored without dropping known windows` (also stated as the intent in its PR), CodeBurn's `skips an unknown window type` | skipped — and this repository's window vocabulary is closed, so an unknown type has no representable kind anyway |
| `resetsAt: null` keeps the window | both fixtures | kept |
| a percentage that is present but not numeric voids the reading | CodexBar's `malformed payload is a classified parse failure` | voided |
| 401/403 → credential problem, 429 → rate limited, 5xx → unavailable | CodexBar's parameterised HTTP expectations | `unauthorized`, `sourceRateLimited`, `unavailable` |
| percentages clamp to 0–100 | all three | clamped, deliberately **not rounded**: the shared burn-rate math reads the raw value |

Two deliberate divergences, recorded so they are not "corrected" later:

- **The monthly window is labelled, not timed.** CodexBar's golden gives it `windowMinutes: 43200`;
  in this repository a `billing` window is the catch-all kind and carries `label: 'Monthly'` instead
  (Kimi's and Command Code's monthly windows, Claude's credit windows), while `windowMinutes` belongs
  to the two fixed-duration kinds.
- **`CLINE_API_KEY` is read before `CLINEPASS_API_KEY`.** CodeBurn orders them the other way round;
  CodexBar and OpenClaude document `CLINE_API_KEY` first, which is what this provider follows. It only
  matters when both are set to different keys.

An account without a subscription answers `limits: []`, which is reported as no data rather than as a
live zero. Two parsing rules follow from what the vendors do with the same payload, and they differ
per field: an **unrecognized window type is skipped** (a window Cline adds later must not take the
reading down), and a **value that is present but is not a number voids the whole reading** — that is a
broken contract, and reporting the rest would show a quota that silently lost a window. A window with
**no `percentUsed` at all stays, without a percentage**: Cline's own dashboard renders that case as
0%, but a fabricated zero would read as a real quota here, and `compactWindowRemaining()` already
treats an absent percentage as unknown.

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
| Settings surface | `LIMIT_PROVIDER_CONNECTION_DETAIL_KEYS` in `src/electron/renderer/app.js`, `settings.limits.connection.cline` in `i18n.js` |

Run focused tests while iterating, then finish with `npm run sync:worker` when shared Worker files
changed, `npm run update:hub-build`, `npm run verify`, and `git diff --check`.

A live check needs a machine signed in to Cline; it is one call, and it needs the credential, so run
it where Cline itself is installed:

```bash
node -e "require('./src/shared/providers/cline/limits').fetchClineLimits().then(r => console.log(r.status, JSON.stringify(r.windows)))"
```
