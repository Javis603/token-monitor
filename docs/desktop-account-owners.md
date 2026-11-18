---
summary: "Desktop limits account owners, host capabilities and renderer boundaries."
read_when:
  - Wiring desktop limits account commands or credential renewal callbacks
  - Changing managed-account login, profile ownership or persistence
---

# Desktop account owners

`src/electron/main.js` assembles provider services and retains IPC, windows, transport construction, the global settings transaction and publication. Provider owners receive named capabilities for their own account/profile fields, persistence, invalidation and host IO. New command consumers can call these owners without loading Electron main or receiving credential-bearing settings.

| Provider | Owner and command boundary |
| --- | --- |
| Claude | Existing `claude/managedAccounts.js`: Web accounts, organization selection, credential resolution, identity observations and renewal. `renewCookie()` routes managed renewals to `renew()` and owns legacy-cookie compare-and-swap. |
| Codex | `codex/accountService.js`: normalization/hydration, workspace labels, isolated managed homes, login/rollback, live-auth preservation and switching, account CRUD and targeted refresh. `login(request, { ownerId, onStatus })`, `selectWorkspace(request, ownerId)` and `cancelLogin(request)` own flow fencing; IPC supplies sender identity and publishes safe status. `switchSystemAccount(id, publish)` holds the credential-swap lane through host publication. |
| OpenCode | `opencode/accountService.js`: `saveCookie`, `logout`, `status`, `getProfiles`, profile CRUD, credential move/remove/merge and ambient-key ownership. Pairing remains an explicit caller assertion through `merge: true`; detected keys remain references to the external authority. |
| Cursor | `cursor/accountService.js`: `loginManual`, `logout`, `setAccountEnabled`, `status` and discovery/cache state. Tokscale remains credential authority; the external-agent gate still blocks credential management and discovery. Injected `auth` and `probe` support isolated fixtures. |
| Antigravity | `antigravity/accountService.js`: OAuth singleflight/cancellation, complete credential records, account CRUD, renderer/collector projections and renewal CAS. `oauthLogin` is an injectable login boundary; production uses the existing OAuth implementation. |
| MiMo | `mimo/accountService.js`: validated console-cookie CRUD, stable account metadata, detected Desktop metadata, collector credentials and legacy cookie-file migration. Console and Desktop membership remain separate products; this extraction introduces no new migration or credential copying between them. |
| WorkBuddy | Existing `workbuddy/managedAccounts.js`: realm validation, login/generation fences, credential resolution/renewal singleflight and account lifecycle. Main retains safe IPC error mapping and publication/invalidation composition. |
| MiniMax | Existing `minimax/apiKeys.js`: key validation, billing/region profile ownership and legacy-key handling. Main supplies settings transactions, transport and change publication. |
| Third-party | `thirdparty/accountService.js`: `getProfiles`, validated/probed `saveProfile`, delete/rename/enable, canonical identity and access/refresh-token-pair CAS. `persistThirdPartyCredentialsRenewal` and `persistThirdPartyAccountKey` remain separate durable callbacks. |

## Persistence and projections

The host `saveSettings` capability preserves the existing synchronous settings/credential transaction and rollback contract. Provider field getters must read the current settings object after a host rollback; owners must not capture a stale settings snapshot. Filesystem auth/home rollback remains Codex-owned, while canonical credential storage remains the shared main-process store. Credential rotations retain their existing compare-and-swap semantics and return durability results to the collector.

Renderer methods explicitly project metadata or configured-state fields. Collector methods may resolve credentials and must never be used as renderer DTOs. Status caches, login controllers and workspace-selection state live with their provider owner. Existing shared-slot renewal remains independent: main forwards `onAccountSlotCredentialRenewed` directly to `accountSlotService.renew`, returning its promise.

Global settings loading still invokes provider normalization and existing startup migrations, including legacy OpenCode-cookie seeding and Codex additional-limits migration. Those compatibility paths, provider transport assembly and presentation selection remain in main. The extraction does not change settings keys, IPC channels, account identity/history or shared account-slot policy.

## Focused validation

`tests/electron/providerOwners.test.js` exercises provider boundaries without Electron or a visible app: cancellation and workspace fences, Codex auth rollback/path confinement, credential CAS, credential-free projections, external Cursor authority, explicit OpenCode pairing and slot-renewal promise forwarding. Existing managed-account, OAuth, profile algebra and source tests cover the underlying provider implementations. Source fixtures inspect owner definitions alongside the main wiring; renderer fixture assertions remain renderer-owned.

## Saved owner slots

MiniMax API keys, Claude Web, Antigravity OAuth and WorkBuddy browser accounts persist through the shared account-slot transaction lane. Their existing IPC remains an adapter to the provider owners: those owners still validate credentials, perform login/renewal and enforce organization, realm and generation fences. When an owner enables collection on save, it persists the selection with the credential. MiniMax Code, Claude OAuth/CLI, Antigravity RPC and WorkBuddy Desktop discovery retain their independent source ownership.

The credential store holds complete main-only owner records, including OAuth client/project context. Renderer lists expose only identity, aliases, labels, enabled state and editor capabilities; collector projections are private and must never become renderer DTOs. Account names and order use shared account presentation; changing either performs no authentication or credential copy. Account rows join device observations only through provider identity keys and aliases, with Alibaba plan variants kept separate. A shared account groups device observations under one identity. When discovery and a saved credential share that identity, Settings also keeps the saved credential’s edit and removal controls available. The device disclosure shows each device’s own status and the selected quota source. Local credential failures are not replaced by a healthy remote observation. Remote-only rows retain presentation controls without local credential actions. Opening the disclosure reads the existing snapshot and starts no probes. Non-slot Codex, Cursor, OpenCode, MiMo and third-party accounts support presentation commands only after main confirms the canonical key.

Startup migration writes the destination, rereads and verifies it, then removes the corresponding legacy credential. Stable source IDs make a retry reuse the destination. Missing credentials remain repairable metadata; disabled records remain disabled. Legacy credentials whose account metadata is unavailable keep the provider migration pending until that metadata is restored. A full saved list leaves remaining legacy accounts and credentials in place for collection and retries import on restart after space is freed. Successfully moved records are no longer visible to older Token Monitor versions: downgrading requires restoring the previous credential/settings backup or signing in again. Migration does not write secrets back into the old layouts for downgrade compatibility.
