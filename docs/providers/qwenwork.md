---
summary: "QwenWork plan credits read from the QwenWork gateway, with an automatic magpie or environment bearer token."
ids: [qwenwork]
read_when:
  - Changing the QwenWork limits provider, its token discovery or its credit windows
  - Adding a QwenWork tracked-client usage source
  - Verifying QwenWork quota against the official client
---

# QwenWork

`qwenwork` is a limits-only provider, without a tracked-client usage source. QwenWork reports plan credits, not per-request token counters, and its desktop app does not persist input/output token counts locally. Adding a usage client would require QwenWork to write usage-bearing transcripts or expose a token-usage API; the credit windows here do not substitute for token accounting.

## Identity and ids

The catalog id is `qwenwork`. It is not a tracked client, is not mapped to one in `LIMIT_PROVIDER_BY_CLIENT`, and has no `clientCatalog` entry. The provider shares the QwenWork account sign-in but keeps its own mark (`assets/icons/qwenwork.svg`).

## Data sources

| Reading | Endpoint |
|---|---|
| User, organization, plan name and reset | `GET /api/v1/adapter/user/account-context?include=user,plan,quota` |
| Plan credits and optional add-on/team pools | `GET /api/v2/quota/usage` |

The quota endpoint is authoritative for the allowance. If it fails without an authentication error, the provider falls back to the `quota` object on `account-context`; identity and plan metadata then remain available. A 401/403 on either request is an authorization failure, not a missing provider.

The plan window is a `billing` window labelled `Credits`; add-on and team pools are marked `additional` so they render as their own rows. The reset timestamp comes from `plan.next_refresh_date`, falling back to `next_due_date`. It is attached only to the plan window.

## Credentials and transport

The Settings account panel starts the same PKCE device flow as the QwenWork desktop client: it opens `https://gateway.qwenwork.cn/device/selectAccounts`, polls `/api/v1/deviceToken/poll`, and stores the access/refresh pair under `providers/qwenwork/session`. An expired access token is refreshed with `/api/v1/deviceToken/refresh` (`target: "c"`); the rotated pair is written back through `onQwenworkSessionRenewed`.

When no stored session exists, the provider falls back in this order:

1. `TOKEN_MONITOR_QWENWORK_TOKEN`, then `QWENWORK_TOKEN`.
2. `plugin-auth.json` → `qwenwork.access` in `$MAGPIE_HOME`, else `~/.config/magpie`, else `%APPDATA%/magpie` on Windows.

A magpie access token whose `expires` timestamp is within 60 seconds is skipped. The provider never refreshes or writes magpie's files; magpie remains the owner of that fallback. QwenWork's desktop app stores its own credential with Electron `safeStorage`, which is encrypted under its bundle identity and is deliberately not decrypted.

The sign-in helper lives in `src/shared/providers/qwenwork/deviceFlow.js`; the main-process IPC is `qwenwork:signIn`, `qwenwork:cancelSignIn` and `qwenwork:signOut`.

Requests use the injected transport, `credentials: 'omit'`, `redirect: 'error'`, and only `https://gateway.qwenwork.cn` (or a `TOKEN_MONITOR_QWENWORK_BASE_URL` on `qwenwork.cn` / `qwenwork.ai`).

## Invariants and known gaps

- No token components, message counts or per-session billing are reported. QwenWork does not expose them locally.
- Upgrading installs seed QwenWork into the saved AI Tool Limits selection and into a custom Home limits order once; removing it afterwards is respected through `qwenworkHomeLimitProviderSeeded`.
- With no stored session and no fallback token it reports `notConfigured` and performs no network request. Settings offers the browser sign-in and explains the fallback through `settings.limits.connection.qwenwork`.
- The gateway reports percentages as fractions (`0.9893` for 98.93%). Parsing multiplies only when the value matches the raw fraction, so a genuine sub-1% percentage survives.
- Credit resets are visible only as the plan window's `resetsAt`; a reset does not create historical token rows.

## Verification

```sh
node --test tests/shared/qwenworkLimits.test.js tests/shared/qwenworkDeviceFlow.test.js
node --test tests/electron/limitProviderOrder.test.js tests/electron/limitProviderWiring.test.js tests/electron/limitProviderCoverage.test.js tests/electron/limitProviderPresentationCoverage.test.js
```
