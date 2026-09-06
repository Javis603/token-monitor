---
summary: "Antigravity provider notes: token/session tracking, local RPC quota probing, standalone OAuth, identity, and aggregation."
read_when:
  - Adding or changing Antigravity token or session tracking
  - Changing Antigravity local RPC or standalone OAuth quota collection
  - Debugging duplicate Antigravity accounts or cross-device aggregation
  - Changing Antigravity credentials, artifact discovery, or endpoint fallbacks
---

# Antigravity provider

Antigravity appears in Token Monitor in two independent data planes. Keep them separate when changing or debugging the provider.

| Data plane | What it measures | Primary runtime | Inputs |
| --- | --- | --- | --- |
| Token/session activity | Local model-token activity attributed to Antigravity | Shared usage collector through `tokscale` | Local Antigravity conversation data and the Token Monitor-managed tokscale cache |
| Limits/quota | Remaining Google account quota and reset windows | Shared limits runtime | A running local Antigravity RPC endpoint, or standalone Google OAuth accounts |

An OAuth account is not a token-history source. Likewise, finding local Antigravity sessions does not identify the Google account that owns a quota row.

## Token and session activity

`src/shared/collector.js` is the only runtime that invokes `tokscale`. Antigravity follows the same today/month/all-time usage pipeline as the other tracked clients.

### Source roots and self-sync

Token Monitor recognizes these native Antigravity roots under `~/.gemini/`:

- `antigravity`
- `antigravity-ide`
- `antigravity-backup`

When Antigravity tracking is enabled and at least one native root exists, `maybeSyncAntigravity()` runs `tokscale antigravity sync` before the relevant scan. `tokscale` writes the normalized cache under its configured `antigravity-cache` directory.

The normalized client id is `antigravity`. The tokscale alias `antigravity-cli` must continue to normalize and filter back to that parent id so targeted scans do not clear one partition and write another.

The parse-local CLI source lives under `${GEMINI_CLI_HOME || ~/.gemini}/antigravity-cli/conversations`. It is a direct scan source rather than part of the native self-sync roots.

### Watch behavior

The native roots are watched because tokscale reads them without writing back to them. A change can therefore trigger an Antigravity-targeted refresh safely.

The generated `antigravity-cache` directory is deliberately not watched. Token Monitor's own sync writes it, so watching it would create a refresh loop.

On Windows, running WSL distros are checked during full scans only. WSL discovery uses the same Antigravity source markers and never starts a stopped distro.

### Boundary with quota collection

Token/session totals are machine-local activity. They are not deduplicated by Google email and do not use the standalone OAuth credentials described below. Changes to quota identity or account aggregation must not alter usage attribution.

## Limits and quota

Antigravity quota collection starts in `fetchAntigravityLimits()` in `src/shared/limitCollector.js`. It supports two sources:

1. local RPC from a running Antigravity app, CLI, or IDE process;
2. standalone OAuth for GUI-managed Google accounts, which continues working while Antigravity is closed.

### Source selection

Local RPC probes prefer process kinds in this order:

1. app
2. CLI
3. IDE

When managed OAuth accounts exist, Token Monitor fetches enabled OAuth accounts and the local RPC snapshot concurrently. If local RPC returns a trusted email matching an OAuth account, the live local result replaces the remote result for that account.

An account-scoped manual refresh fetches only the requested OAuth account. With no managed accounts, normal collection remains local-RPC-only.

### Local RPC

The probe discovers a running process and its local service ports, then connects to the loopback RPC service. It tries the grouped quota summary path first and uses user status to obtain identity when available. Older model-config RPC methods remain fallbacks for Antigravity builds without the grouped quota response.

Identity lookup may fail while quota lookup succeeds. Such a row is valid but anonymous; it must remain device-scoped during hub aggregation. Do not give anonymous RPC rows a cross-device-stable fallback key, because two unrelated Google accounts could otherwise collapse into one row. An anonymous local row also cannot be safely matched to a managed OAuth account, so both rows may be visible until local identity becomes available.

### Standalone OAuth

The Electron main process owns the browser OAuth flow:

- the callback server binds only to `127.0.0.1` on an ephemeral port;
- `state` is a 32-byte random value;
- authorization-code exchange uses PKCE with `S256`;
- a callback with the wrong state is rejected without cancelling the valid pending flow;
- access and refresh tokens remain in the main-process credential store;
- the renderer receives account metadata only.

OAuth client discovery prefers explicit environment overrides, then supported installed artifacts, and finally the bundled official Antigravity Hub desktop client pair. Installed-artifact discovery is an optional compatibility source, not a requirement for standalone login. The bundled fallback is what keeps the flow available across supported desktop platforms.

The OAuth scopes intentionally cover Cloud Code quota access plus Google profile/email identity. Account identity currently uses the normalized email returned by Google userinfo rather than OpenID `sub`; keep the user-info request and identity derivation aligned if the scopes change.

Remote quota collection uses the Cloud Code bootstrap, onboarding, grouped quota-summary, available-models, and legacy quota endpoints. Available-model discovery retains production, daily, and sandbox endpoint fallbacks. The legacy quota request is also used to verify suspicious all-100-percent grouped responses.

A generic `403 PERMISSION_DENIED` may mean that one quota endpoint is unavailable and must continue through the existing fallbacks. Only a 403 that explicitly asks the user to verify the account at `accounts.google.com` becomes `actionRequired: accountVerification`; the UI then directs the user to open Antigravity, complete verification, and refresh. Never forward the provider-supplied verification URL because it may contain account-specific parameters.

### Quota mapping

Grouped quota responses map into the normalized limits windows used by every provider. Preserve the distinction between:

- Gemini windows;
- Claude/GPT shared windows;
- five-hour windows;
- weekly windows.

Older model-config responses are pooled into compatible fallback windows. UI labels and grouping should describe the upstream pool rather than inventing per-model precision the response does not contain.

### Identity and aggregation

Managed OAuth accounts use a normalized Google email to derive their stable `accountKey`. An identified local RPC row uses the same derivation, allowing RPC/OAuth deduplication and cross-device collapse for the same account.

Anonymous local RPC rows are different: even if their local fallback hashes match, `aggregateLimits()` must scope them to the originating device. Preserve this invariant in both the Node and Worker copies of the aggregation logic.

When changing normalized limits behavior:

1. edit `src/shared/limits.js`;
2. run `npm run sync:worker` to regenerate `worker/src/shared/limits.js`;
3. add coverage for same-account deduplication and anonymous cross-device separation.

## Settings and credentials

GUI-managed account metadata lives in `settings.antigravityManagedAccounts`. Raw tokens live under the Antigravity account namespace in the shared credential store, never in renderer-visible settings.

Settings persistence failures must leave account metadata unchanged. `saveSettings()` owns the in-memory settings rollback, while Antigravity account handlers compensate any dynamic credential write performed before that transaction. Credential writes and metadata writes form one user-visible operation even though they use separate files.

Managed account metadata must still reach the collector when its credential is missing or unreadable. The collector turns that account into an actionable unauthorized row so the UI can ask the user to sign in again; silently filtering it out would leave Settings claiming that the account is linked while quota collection behaves as though it does not exist.

The headless agent and standalone hub do not read the widget credential store. They can receive already-normalized limits through the normal device record, but they do not inherit the widget's managed OAuth accounts.

## Platform behavior

The bundled OAuth client and loopback browser flow are platform-independent. Environment overrides are also platform-independent. Installed-artifact discovery is only an optional source and may have platform-specific paths.

Local RPC availability depends on a compatible Antigravity process and discoverable loopback endpoint on that machine. Standalone OAuth is the path that allows quota refresh while all Antigravity processes are closed.

Token/session tracking remains dependent on local source data. OAuth does not make local token history available when the underlying Antigravity data is absent.

## Change map

| Concern | Primary files |
| --- | --- |
| Usage source roots, watch mapping, and self-sync | `src/shared/collector.js`, `src/shared/clientTracking.js`, `src/shared/clientHealth.js`, `src/shared/usage.js` |
| Local RPC and remote quota requests | `src/shared/providers/antigravity/probe.js`, `src/shared/providers/antigravity/oauth.js`, `src/shared/providers/antigravity/limits.js` |
| Browser OAuth lifecycle | `src/electron/providers/antigravity/oauthLogin.js`, `src/electron/main.js`, `src/electron/preload.js` |
| Account settings and credentials | `src/shared/credentialStore.js`, `src/electron/main.js`, renderer settings files |
| Normalization and cross-device aggregation | `src/shared/limits.js`, generated `worker/src/shared/limits.js` |
| Limits presentation | `src/electron/renderer/limitProviderPresentation.js`, `src/electron/renderer/app.js`, localized strings |
| Hub build identity after shared changes | `src/shared/hubBuildRegistry.json`, generated Worker registry |

## Verification checklist

For provider changes, cover the affected paths rather than treating one successful OAuth login as complete validation:

- native root and parse-local token discovery;
- targeted watch refresh without a cache feedback loop;
- local RPC with and without account identity;
- app-closed standalone OAuth refresh;
- access-token refresh and persistence;
- matching RPC/OAuth account replacement;
- multiple managed accounts;
- anonymous RPC separation across devices;
- Node/Worker aggregation parity;
- settings persistence rollback;
- platform-specific artifact discovery when changed.

Run focused tests while iterating, then finish with `npm run sync:worker` when shared Worker files changed, `npm run verify`, and `git diff --check`.
