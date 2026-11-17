---
ids: [copilot]
summary: Copilot account slots, enterprise identity, legacy imports and device-flow login.
read_when:
  - Changing Copilot quota collection, saved accounts, enterprise hosts or browser sign-in
---

# GitHub Copilot

Copilot uses the shared account-slot panel for pasted OAuth tokens and browser device-flow sign-in. Each saved slot owns its token and optional non-secret enterprise host. Rename, pause, reorder, replace and remove use the shared slot service. A replacement proven to belong to another GitHub identity must be added as a separate account.

The provider owns device authorization, identity lookup, progress and cancellation in main. The shared login action accepts a main-only producer returning `{ values, identity, isCurrent, label? }`; after authentication it serializes the commit with other slot mutations and checks `isCurrent` again before writing. Tokens never return to the renderer. The existing `copilot:*` methods and flowId/loginStatus events remain supported; account management forwards to slots.

Desktop startup imports `copilotProfiles` once, in profile order, then imports an unmatched legacy fixed token. It preserves tokens, effective hosts, enabled flags and existing account keys. Server `accountName` values are not user labels. Stable source-derived IDs allow retry after an interrupted write; the destination is read back and verified before the legacy secrets are stripped. Older application versions cannot see migrated accounts.

Saved accounts take precedence over environment credentials, including when paused. Without saved accounts, `COPILOT_API_TOKEN` precedes `GITHUB_COPILOT_TOKEN`; the configured host precedes `COPILOT_ENTERPRISE_HOST`, then `GITHUB_ENTERPRISE_HOST`, then github.com. The headless collector and Hub do not read desktop credentials.

GitHub identity is keyed by login (or numeric ID), namespaced by enterprise host. github.com retains its existing hash. Token hashes are fallback identities, not proof of a different server account. Quota calls use the injected transport and isolated per-account runtime state. Pasted tokens follow the shared probe policy: unauthorized drafts are rejected; temporary quota failures may save an unconfirmed draft. Browser sign-in still requires a successful identity lookup before committing.
