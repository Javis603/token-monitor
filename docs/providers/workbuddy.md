---
summary: "WorkBuddy provider notes: the app-owned local session, its credential-encryption boundary, the headless token lane, and the billing contract."
ids: [workbuddy]
read_when:
  - Adding or changing WorkBuddy limits collection
  - Changing how the WorkBuddy desktop session is read, validated, or reported
  - Debugging a WorkBuddy row that shows as signed out on a signed-in machine
  - Changing WorkBuddy credential handling or the app-session security boundary
---

# WorkBuddy provider

WorkBuddy appears in Token Monitor in two independent data planes. Keep them separate when changing or debugging the provider.

| Data plane | What it measures | Primary runtime | Inputs |
| --- | --- | --- | --- |
| Token/session activity | Local model-token activity attributed to WorkBuddy | Shared usage collector through `tokscale` | Local WorkBuddy conversation data |
| Limits/quota | Remaining WorkBuddy Credits | Shared limits runtime | The installed WorkBuddy desktop app's session, or an explicit billing token |

Local App monitoring runs in the Electron main process on macOS and Windows. Linux has no supported local app session, and the Widget reports that capability as unavailable rather than falling back to a token.

## Limits and quota

`fetchWorkbuddyLimits()` in `src/shared/providers/workbuddy/limits.js` owns the request and the response mapping. Both billing paths post to `https://copilot.tencent.com` — `/v2/billing/meter/get-user-resource` for personal accounts and `/v2/billing/meter/get-enterprise-user-usage` when an enterprise id is present. The personal request mirrors the official client's package selection (`ProductCode: p_tcaca`, `Status: [0, 3]`) but aggregates only `Status 0` rows, because the `Status 3` history packages are not part of the spendable balance.

`parsePersonalUsage()` fails closed when any active package carries unusable quota data: a partial aggregate would look plausible while silently omitting a package. An account with no active package stays a configured row with zero resources instead of becoming an error.

### Source selection

The desktop widget may only use the app-owned session. `electronLimitsConfig()` passes `workbuddyDesktopSessionOnly: true`, and `limitsConfigFromSettings()` turns that into empty settings and env for the WorkBuddy lane, so a stale `.env` or legacy settings token cannot silently outrank the app session. The headless agent and CLI keep the `TOKEN_MONITOR_WORKBUDDY_*` fallback; those fields are not a widget setup path.

Within the widget lane, an explicit token still wins when one is actually resolved, and `useLocalApp` requires no token plus an enabled lane plus an injected `workbuddyFetch`. Keep that precedence: the local session is the default, not an override.

## The app-owned session

`src/electron/providers/workbuddy/localAuth.js` reads the session the installed app writes. On Windows it prefers `%LOCALAPPDATA%` and falls back to `%APPDATA%`; on macOS it reads `~/Library/Application Support`. In both cases the path is `CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`.

Non-obvious constraints that must survive refactors:

- **The first directory with canonical state decides.** Once the preferred location holds the file or a `.logged-out` marker, the reader does not fall back to a legacy directory, so a stale roaming copy cannot revive a session the user ended.
- **Only the canonical filename is trusted.** A sibling file is never read, even when it looks like a session.
- **Symlinks and oversized files are refused** through `readRegularFileNoFollow` and the 1 MB cap.
- **No credential is stored by Token Monitor.** The access token lives in memory for the duration of one billing request: it is never written to settings, logs, or Token Monitor's own wire, and it leaves the machine only inside the allowlisted HTTPS billing request described under [Request contract](#request-contract).

### Credential encryption

WorkBuddy 5.6.0 and later seal individual credential fields with the at-rest key their own runtime holds, so `auth.accessToken` arrives as a `{$wbEncrypted: 1, envelope: …}` shell instead of a string. On supported Windows desktop installs, Token Monitor passes that wrapper through a short-lived WorkBuddy-owned runtime helper. The helper keeps the runtime key inside that WorkBuddy process, invokes the bundled private codec interface verified with WorkBuddy 5.6.2, and never copies the key into Token Monitor, hard-codes it, stores it, logs the token, or exposes it to the renderer. The token exists only in memory for the allowlisted billing request. A future WorkBuddy change to that private interface fails closed with the encrypted read reason. macOS and unsupported platforms retain the encrypted read reason and fail closed.

The reader therefore reports *why* a session is unusable rather than collapsing every failure into "not signed in". `WORKBUDDY_SESSION_READ_REASONS` names the states — `absent`, `unsupported`, `malformed`, `incomplete`, `encrypted`, `expired` — and `getSessionInfo()` carries the non-empty one on a failed read. A Windows encrypted metadata read is considered signed in, while a codec failure marks the request with the encrypted reason. That reason maps through `WORKBUDDY_SESSION_REASON_ENCRYPTED` in the shared module to `actionRequired: appSessionEncrypted`.

That distinction is the whole point: an encrypted credential is not a signed-out app, and telling the user to sign in again sends them to a screen that cannot change the outcome. Keep the two apart when adding read states:

| Read reason | Limits outcome | Renderer |
| --- | --- | --- |
| `encrypted` | `notConfigured` + `actionRequired: appSessionEncrypted` | "Encrypted by app" |
| `absent`, `incomplete`, `malformed` | `notConfigured` | "Sign in" |
| `expired` | `unauthorized` | "Sign in again" |

`expired` is the one state where the read and the request disagree, and it is worth knowing why: `getSessionInfo()` hides an expired session, so the enabled local lane proceeds to a request, and `request()` re-reads the same file and rejects it as `unauthorized`. That rejection is what produces the "Sign in again" prompt.

`normalizeStoredSession()` stays the session-or-null accessor for callers that only want a session; `inspectStoredSession()` returns the `{ session, reason }` pair. Both live in the Electron layer, so the shared limits module receives the reason as plain configuration rather than reaching back into the reader.

## Request contract

`createWorkbuddyLocalAuth().request()` injects authentication only after `isAllowedWorkbuddyApiUrl()` has matched the exact https host, path and method with no credentials, port, query or fragment. It sets `redirect: 'error'` so the token can never follow a redirect, strips caller-supplied authentication headers, and re-reads the session after the response to reject a mid-request account switch. Preserve all four when touching the transport: they are the reason the provider is allowed to handle an app-owned credential at all.

## Change map

| Concern | Primary files |
| --- | --- |
| App session reading, encryption detection, read reasons | `src/electron/providers/workbuddy/localAuth.js`, `src/electron/providers/workbuddy/credentialDecoder.js` |
| Billing request and response mapping | `src/shared/providers/workbuddy/limits.js` |
| Widget lane configuration and reason plumbing | `src/electron/main.js`, `src/electron/runtimeConfig.js` |
| Action hint bounds | `src/shared/limits/core.js`, generated `worker/src/shared/limits/core.js` |
| Status label and localized strings | `src/electron/renderer/limitProviderPresentation.js`, `src/electron/renderer/i18n.js` |
| Wire contract | `docs/API.md` |

## Verification checklist

- personal and enterprise billing mapping, including the unlimited enterprise plan;
- an empty active-package list staying visible as configured;
- a sealed credential opening on supported Windows and retaining the `encrypted` action on unsupported platforms or codec failure;
- the read reasons for absent, malformed, oversized, incomplete and expired sessions;
- the widget lane refusing a legacy `.env` or settings token;
- an explicit token outranking the local session;
- the allowlisted endpoint, header stripping, and mid-request session switch rejection.

Run focused tests while iterating, then `npm run sync:worker` when `src/shared/limits/core.js` changed, `npm run verify`, and `git diff --check`.
