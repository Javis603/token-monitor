---
ids: [copilot]
summary: Copilot account slots, enterprise identity, legacy imports and device-flow login.
read_when:
  - Changing Copilot quota collection, saved accounts, enterprise hosts or browser sign-in
---

# GitHub Copilot

Copilot uses the shared account-slot panel for pasted OAuth tokens and browser device-flow sign-in. Each saved slot owns its token and optional non-secret enterprise host. Rename, pause, reorder, replace and remove use the shared slot service. A replacement proven to belong to another GitHub identity must be added as a separate account.

Saved slots retain the public GitHub login as `accountName`, separately from custom labels. The compatibility account list exposes it after restart, including paused accounts. A successful provider refresh fills missing names; a temporary missing name does not clear an existing name for the same identity.

The provider owns device authorization, identity lookup, progress and cancellation in main. The shared login action accepts a main-only producer returning `{ values, identity, isCurrent, label? }`; after authentication it serializes the commit with other slot mutations and checks `isCurrent` again before writing. Tokens never return to the renderer. The existing `copilot:*` methods and flowId/loginStatus events remain supported; account management forwards to slots.

Desktop startup imports `copilotProfiles` once, in profile order, then imports an unmatched legacy fixed token. It preserves tokens, effective hosts, enabled flags and existing account keys. Server `accountName` values are not user labels. Stable source-derived IDs allow retry after an interrupted write; the destination is read back and verified before the legacy secrets are stripped. Older application versions cannot see migrated accounts. If the source exceeds the saved-slot limit, startup imports only the accounts that fit and retains the remainder as read-only migration input. All enabled legacy accounts continue collecting alongside slots, deduplicated by token and effective host; paused legacy accounts do not collect or enable the environment lane. The marker stays absent until every usable account has been imported. A startup warning directs users to remove saved accounts and restart to import the remainder. Failed destination writes or verification retain the source for collection and retry. Once the migration marker exists, runtime config excludes legacy credentials. The legacy map has no renderer management lifecycle or write path.

Saved accounts take precedence over environment credentials, including when paused. Without saved accounts, `COPILOT_API_TOKEN` precedes `GITHUB_COPILOT_TOKEN`; the configured host precedes `COPILOT_ENTERPRISE_HOST`, then `GITHUB_ENTERPRISE_HOST`, then github.com. The headless collector and Hub do not read desktop credentials.

GitHub identity is keyed by login (or numeric ID), namespaced by enterprise host. github.com retains its existing hash. Token hashes are fallback identities, not proof of a different server account. Quota calls use the injected transport and isolated per-account runtime state. Pasted tokens follow the shared probe policy: unauthorized drafts are rejected; temporary quota failures may save an unconfirmed draft. Browser sign-in still requires a successful identity lookup before committing.
