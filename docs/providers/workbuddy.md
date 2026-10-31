---
summary: "WorkBuddy provider notes: transcript roots and shared session readers, the app-owned credential session, its encryption boundary, managed browser login and account identity, and the billing contract."
ids: [workbuddy]
read_when:
  - Changing WorkBuddy session discovery, titles, turn status or Session Detail
  - Adding or changing WorkBuddy limits collection
  - Changing how the WorkBuddy desktop session is read, validated, or reported
  - Debugging a WorkBuddy row that shows as signed out on a signed-in machine
  - Changing WorkBuddy credential handling or the app-session security boundary
---

# WorkBuddy provider

WorkBuddy's usage, transcript enrichment and quota reads have independent sources. Keep them separate when changing or debugging the provider.

| Data plane | What it measures | Primary runtime | Inputs |
| --- | --- | --- | --- |
| Token/session activity | Local model-token activity attributed to WorkBuddy | Shared usage collector through `tokscale` | Local WorkBuddy conversation data |
| Session metadata and Detail | Titles, turn boundaries, prompts, tools and per-turn tokens | Shared local metadata and Session Detail readers | WorkBuddy JSONL transcripts |
| Limits/quota | Remaining WorkBuddy Credits | Shared limits runtime | The discovered desktop session, managed browser logins, or a headless billing token |

Local App quota monitoring runs in the Electron main process on macOS and Windows. Linux has no supported local app credential session. Managed browser login is independent of desktop-session discovery and remains available there. This platform restriction does not apply to local transcript readers.

## Session transcripts

Session discovery checks `~/.workbuddy/projects/**/*.jsonl`, then `~/.workbuddy-ai/projects/**/*.jsonl`; the latter is the home used by WorkBuddy 5.5. Both remain supported because tokscale scans both, and the first matching transcript wins. `providers/workbuddy/sessionMetadata.js` binds the shared CodeBuddy metadata reader to these roots. Token totals continue to come from tokscale, independently of whether a local transcript can be resolved.

The shared resolver receives the client id in its context and keeps existing metadata under `workbuddy:<sessionId>`. Bare session ids can coincide with CodeBuddy ids; sharing a parser must not share cached titles, turn state or project identity across clients.

WorkBuddy shares the [CodeBuddy transcript format and readers](codebuddy.md#workbuddy-writes-the-same-family), with two compatibility rules: a non-empty `custom-title` takes priority over `ai-title`, and older records without `providerData.messageId` or cache details still produce turns from their usage-bearing records. WorkBuddy's `<user_query>` prompt is extracted from the surrounding context envelope. Token conversion follows the pinned Tencent Buddy parser, including usage-object precedence, conditional cache subtraction and additive reasoning/cache writes; live rows, history and Detail share the same total.

On-demand Session Detail uses the shared streaming line reader and CodeBuddy parser. It retains the 16 MiB per-record bound and explicit read-error results; Windows detail resolution follows the async native-to-WSL fallback contract. There is no CodeBuddy VS Code extension-store fallback for WorkBuddy, whose conversations use the transcript roots above.

The shared metadata scanner still skips records above 64 KiB, so oversized user or assistant records can leave turn status stale. This metadata limit is separate from Session Detail's record bound. The desktop credential-encryption boundary described below concerns quota access; it does not prevent reading local session transcripts.

WorkBuddy rows get their tok/s reading from the shared CodeBuddy throughput pass: the reader sums each transcript's `turn-metrics` records into the raw counters a row divides at display time, exactly as [described for CodeBuddy](codebuddy.md#turn-throughput-toks). Nothing here is WorkBuddy-specific — it follows from sharing the transcript family.

## Limits and quota

`fetchWorkbuddyLimits()` in `src/shared/providers/workbuddy/limits.js` owns the request and the response mapping. The existing CN discovery/headless billing paths post to `https://copilot.tencent.com` — `/v2/billing/meter/get-user-resource` for personal accounts and `/v2/billing/meter/get-enterprise-user-usage` when an enterprise id is present. The personal request mirrors the official client's package selection (`ProductCode: p_tcaca`, `Status: [0, 3]`) but aggregates only `Status 0` rows, because the `Status 3` history packages are not part of the spendable balance.

`parsePersonalUsage()` fails closed when any active package carries unusable quota data: a partial aggregate would look plausible while silently omitting a package. An account with no active package stays a configured row with zero resources instead of becoming an error.

### Source selection

The widget keeps app-owned discovery and adds explicit managed accounts. `workbuddyDesktopSessionOnly` continues to suppress legacy settings/env tokens: a stale `.env` must not silently outrank the discovered session. Managed accounts enter a separate runtime context, with secrets resolved in main through the existing `CredentialStore`. The headless agent and CLI retain their existing `TOKEN_MONITOR_WORKBUDDY_*` path and never read widget credentials.

Discovered and managed identities form one set. A managed account takes precedence for the same realm, user and enterprise context, including when disabled, so the discovered copy cannot re-enable it or double its quota. A different locally active account remains visible beside managed accounts. Account names are display metadata; refresh scopes use account keys or ids. CN account keys retain the previous `user:` / `enterprise:` hashing contract so existing subscription bindings survive. International identities include their realm and must never collide with CN identities.

### Managed login and refresh

The main process starts a realm-specific official login, opens the returned official authorization page, and polls the server-issued state. CN uses `https://www.codebuddy.cn/v2/plugin/auth/state?platform=workbuddy`; international uses `https://www.workbuddy.ai/v2/plugin/auth/state?platform=workbuddy-ai`. The accepted authorization URL must match the initiating realm, platform and state. Token polling treats only code `11217` as pending; account polling treats `12151` as pending. Request deadlines, an overall timeout and cancellation bound the flow. This is the official state/polling protocol, not a loopback authorization-code callback. Settings advertise this login entry point as `Web` alongside automatic desktop discovery; do not label it standard OAuth without a verified protocol contract.

Settings hold bounded identity metadata; access/refresh tokens live under `providers.workbuddy.accounts.<id>.credentials` in the shared credential store. Raw tokens, state, authorization URLs and provider error payloads never enter renderer settings, logs or the device wire record. Token Monitor does not switch the WorkBuddy app account or write any WorkBuddy/CodeBuddy session file.

Refresh runs once per account at a time, uses the initiating account's realm and `X-Refresh-Token` / `X-Auth-Refresh-Source: plugin`, and saves valid rotated credentials before quota retry. Removed, disabled or replaced account state fences late refresh results. Network errors, throttling and server failures preserve credentials; confirmed authentication rejection requires sign-in. Stable identity remains available to subscription bindings while credentials are missing or unavailable. Official enterprise account types include `ultimate` and `exclusive`. Department names remain bound metadata; refresh does not need a department header. Billing preserves printable ASCII department headers for compatibility and omits names that cannot be represented as an HTTP header, without inventing a server-side encoding.

The official protocol and anonymous entry point have been checked with Node and isolated native Electron transport. Real account login, quota comparison and refresh-token rotation still need a signed-in test account; international quota compatibility and Windows native behavior must not be described as verified from these fixture tests.

### Account rows and totals

Grouped quota cards show one provider mark and an account count in the header; account rows align with the other managed providers without repeating the mark. A standalone account retains its provider mark.

Limits, Home and the Edge Dock show individual accounts by default. The WorkBuddy option “Show quota total” (`workbuddyQuotaTotalEnabled`, default `false`) adds a group total on Limits and Dock and combines compatible accounts on Home. This is a display sum, not a shared quota pool: each account retains its own spendable balance. With the option enabled, accounts still stay independent whenever any account is unavailable, stale, unlimited, has no finite quota, or uses a different realm or quota/reset contract. Fresh observations of one account do not discard stale siblings in the cross-device aggregate. A total is display-only and appears only when every unique account has compatible healthy finite Credits windows. The wire continues to carry the individual accounts. Known identities and saved subscription bindings remain selectable through failed or missing credentials, including when editing an existing record. The legacy realm-specific `local-app` sentinel hashes remain wire-compatible, but unnamed failed placeholder rows are excluded from subscription choices and suppressed in the cross-device aggregate whenever a real account identity exists, even when all real accounts have missing or encrypted credentials; saved bindings are added independently afterward. The shared `providers/workbuddy/identity.js` predicate distinguishes these placeholders from real known accounts, including unnamed identities with missing or rejected credentials. Each real account retains its own failure hint. Only when no real account identity exists does the aggregate retain the placeholder and its first-sign-in/encryption hint; the underlying local device observation is unchanged. Managed-account Settings status follows the existing visibility-aware stats render path, without additional polling.

Full discovery compares against the runtime’s accepted snapshot and emits internal removal markers for confirmed vanished or disabled accounts. Malformed or incomplete local discovery does not establish absence: even a known encrypted account with no successful quota retains its identity metadata during a transient missing observation. Removing a managed account clears that exact identity and refreshes the discovery union, so a still-signed-in desktop session can become visible again. Limits and Dock totals additionally require their visible rows to cover the complete known account pool; hidden or non-reporting siblings cannot produce a partial total. This completeness check excludes only `isWorkbuddyPlaceholder` rows, which may remain in the raw local/aggregate subscription pool during sync. Real failed, keyless, incomplete, stale or unlimited accounts still prevent a partial total; the global pool and first-sign-in/encryption hints are unchanged. A saved WorkBuddy context key matches exactly, without healing onto a sibling by name, email, or a sole-account fallback.

Quota collection runs at most four distinct accounts concurrently across the managed and discovered lanes; credential resolution, refresh and billing all occupy the same account slot. Each network/credential step retains its 12-second deadline. The entire account sequence also receives a share of the remaining 120-second provider work budget, divided by the remaining waves of up to four accounts. Fast completions leave time available to later accounts; stalled first accounts cannot consume the full provider deadline before the queue advances. The runtime's additional 5-second cleanup grace is not included in this work budget. Large account sets can consequently receive shorter account deadlines and report `unavailable`; this does not guarantee that every slow account can succeed within a finite provider budget. Cancellation or budget exhaustion prevents queued credential/network operations from starting. Every selected identity still returns an ordered result row, including an `unavailable` row for canceled or timed-out work, and one account's failure does not discard its siblings or remove credentials.

## The app-owned session

`src/electron/providers/workbuddy/localAuth.js` reads the session the installed app writes. On Windows it prefers `%LOCALAPPDATA%` and falls back to `%APPDATA%`; on macOS it reads `~/Library/Application Support`. Both realms use the `CodeBuddyExtension/Data/Public/auth` directory with the canonical filenames below.

Non-obvious constraints that must survive refactors:

- **The first directory with canonical state decides.** Once the preferred location holds the file or a `.logged-out` marker, the reader does not fall back to a legacy directory, so a stale roaming copy cannot revive a session the user ended.
- **Only realm-specific canonical filenames are trusted.** CN uses `workbuddy-desktop.info`; international uses `workbuddy-desktop-ai.info`. Backup files are never used to revive a session. Each realm keeps its own logout marker and discovery precedence.
- **Symlinks and oversized files are refused** through `readRegularFileNoFollow` and the 1 MB cap.
- **Discovered credentials stay app-owned.** The discovered access token lives in memory for the duration of one billing request: it is never written to settings, logs, or Token Monitor's own wire, and it leaves the machine only inside the allowlisted HTTPS billing request described under [Request contract](#request-contract).

### Credential encryption

WorkBuddy 5.6.0 and later seal individual credential fields with the at-rest key their own runtime holds, so `auth.accessToken` arrives as a `{$wbEncrypted: 1, envelope: …}` shell instead of a string. Token Monitor cannot open that envelope and must not try to: the key is loaded by the app's own native binding, and no supported surface exposes it.

The reader therefore reports *why* a session is unusable rather than collapsing every failure into "not signed in". `WORKBUDDY_SESSION_READ_REASONS` names the states — `absent`, `unsupported`, `malformed`, `incomplete`, `encrypted`, `expired` — and `getSessionInfo()` carries the non-empty one on a failed read. Only the encrypted case changes the limits outcome, through `WORKBUDDY_SESSION_REASON_ENCRYPTED` in the shared module (the one value both layers agree on) becoming `actionRequired: appSessionEncrypted`.

That distinction is the whole point: an encrypted credential is not a signed-out app, and telling the user to sign in again sends them to a screen that cannot change the outcome. Keep the two apart when adding read states:

| Read reason | Limits outcome | Renderer |
| --- | --- | --- |
| `encrypted` | `notConfigured` + `actionRequired: appSessionEncrypted` | "Encrypted by app" in Settings and the shared Limits/Dock row |
| `absent`, `incomplete`, `malformed` | `notConfigured` | "Sign in" |
| `expired` | `unauthorized` | "Sign in again" |

`expired` is the one state where the read and the request disagree, and it is worth knowing why: `getSessionInfo()` hides an expired session, so the enabled local lane proceeds to a request, and `request()` re-reads the same file and rejects it as `unauthorized`. That rejection is what produces the "Sign in again" prompt.

`normalizeStoredSession()` stays the session-or-null accessor for callers that only want a session; `inspectStoredSession()` returns the `{ session, reason }` pair. Both live in the Electron layer, so the shared limits module receives the reason as plain configuration rather than reaching back into the reader.

## Request contract

`createWorkbuddyLocalAuth().request()` injects authentication only after `isAllowedWorkbuddyApiUrl()` has matched the exact https host, path and method with no credentials, port, query or fragment. It sets `redirect: 'error'` so the token can never follow a redirect, strips caller-supplied authentication headers, and re-reads the session after the response to reject a mid-request account switch. Preserve all four when touching the transport: they are the reason the provider is allowed to handle an app-owned credential at all.

## Change map

| Concern | Primary files |
| --- | --- |
| Transcript metadata and roots | `src/shared/providers/workbuddy/sessionMetadata.js`, shared CodeBuddy transcript readers |
| Transcript discovery and streaming Detail | `src/shared/sessionFiles.js`, `src/shared/sessionDetail.js`, `src/shared/sessionDetailResolver.js` |
| App session reading, encryption detection, read reasons | `src/electron/providers/workbuddy/localAuth.js` |
| Official login, refresh and managed credentials | `src/shared/providers/workbuddy/oauth.js`, `src/electron/providers/workbuddy/oauthLogin.js`, `src/electron/providers/workbuddy/managedAccounts.js`, shared `CredentialStore` |
| Billing request and response mapping | `src/shared/providers/workbuddy/limits.js` |
| Widget lane configuration and reason plumbing | `src/electron/main.js`, `src/electron/runtimeConfig.js` |
| Action hint bounds | `src/shared/limits/core.js`, generated `worker/src/shared/limits/core.js` |
| Status label and localized strings | `src/electron/renderer/limits/providerPresentation.js`, `src/electron/renderer/i18n.js` |
| Wire contract | `docs/API.md` |

## Verification checklist

- both transcript roots, custom-title precedence and older ungrouped usage records;
- streamed Session Detail, oversized-record errors and async WSL fallback;
- personal and enterprise billing mapping, including the unlimited enterprise plan;
- an empty active-package list staying visible as configured;
- a sealed credential reporting `encrypted` rather than a missing sign-in;
- the read reasons for absent, malformed, oversized, incomplete and expired sessions;
- the widget lane refusing a legacy `.env` or settings token;
- an explicit token outranking the local session;
- the allowlisted endpoint, header stripping, and mid-request session switch rejection;
- realm/state/platform-bound official browser login, both pending codes and cancellation/timeouts;
- refresh single-flight, rotated-token persistence, transient retention and account-mutation fences;
- same-name account scopes, discovered/managed dedup, disabled/removed identities and partial discovery;
- independent partial/unlimited rows, compatible complete totals and persistent subscription choices.

Run focused tests while iterating, then `npm run sync:worker` when `src/shared/limits/core.js` changed, `npm run update:hub-build` after the final shared changes, `npm run verify`, and `git diff --check`.

For session changes, run `node --test tests/shared/workbuddySessionMetadata.test.js tests/shared/sessionDetail.codebuddy.test.js tests/shared/sessionDetailStreaming.test.js tests/shared/sessionDetailResolver.test.js`.
