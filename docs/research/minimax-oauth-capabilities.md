# MiniMax Code OAuth: source and behavior checks

Checked 2026-10-24 against the installed MiniMax Code 3.1.6, extracted with the already cached official `@electron/asar` 4.3.0. No package installation or custom ASAR parser was used.

## Extraction provenance

- Input: `/Applications/MiniMax Code.app/Contents/Resources/app.asar`.
- Tool: `/Users/remixplay/.npm/_npx/4b0e2640fe917ac8/node_modules/@electron/asar/bin/asar.mjs`.
- Destination: `/tmp/minimax-code-official-3.1.6-review`.
- Archive SHA-256: `8f51cc75d357d4da541d66f7fd34ce3004653ae191dd16a4b5f44421a1dc589b`.
- The official `extract` command reported 22 missing external `app.asar.unpacked` native files, including other-platform builds. All 28,409 archive-contained files were compared byte-for-byte with the same official package's `extractFile()` API: zero mismatches. The JavaScript sources used below are intact. `/tmp/minimax-official-extraction-manifest.json` records the missing external files separately.

## What one OAuth session can read

The desktop app uses `mcode-public`, `agent.default`, and `agent-backend`. Its Electron adapter strips renderer-supplied credentials; main supplies its current Bearer lease on configured official origins. The commerce SDK additionally sends `X-Group-Id`. These are existing-account reads, not API-key creation.

| Data | Official endpoint | Verified scope and integration decision |
| --- | --- | --- |
| Personal/team workspaces | POST `/matrix/api/v1/user/get_user_extra_info` with `{}` | Live query returned one personal workspace with numeric ID **0**, which is valid. Collection explicitly selects the personal workspace, sends its ID to membership, and never changes the app's default workspace. |
| Code purchased/free credit total and plan eligibility | POST `/matrix/api/v1/commerce/get_membership_info` with `workspace_id` | Live total 4,624 = purchased 0 + free 4,624; `has_token_plan` false. Integrated once as points, separate from API money. |
| API wallet | GET `/account/query_balance` on the Open Platform origin | The same Bearer plus group header returned HTTP 200 / business code 0: available 15.00, cash 0.00, vouchers 15.00 CNY. Integrated as a separate `API Balance` window using the existing API balance parser. No pasted key is needed. Failure/refusal does not invalidate Code credits. |
| M Plan interval/weekly/video quota | GET `/backend/account/token_plan/remains_percent` | Live success with no quota rows is consistent with this account having no plan. Used/total, unlimited and video shapes are covered with fixtures. |
| Credit grant detail and expiry | GET `/minimax-cloud/api/v1/credit/details` | Earlier live read reconciled active grants to the summary; expired historical remaining amounts must not be added. See [credit pool evidence](minimax-credit-pools.md). |
| Usage history | GET `/backend/account/token_plan/usage_summary` | Same Bearer returned success and historical arrays. The official UI requests `token_type: 5, heatmap_days: 365`. This is platform history; it is not merged into local client token accounting, where it could overlap existing records. |
| Subscription list | GET `/backend/account/token_plan/subscriptions` | Same Bearer returned success, total 0 on this account. No purchase, assignment or cancellation was invoked. |
| User identity | GET `/v1/api/user/info`; renderer also has `/matrix/api/v1/user/profile` | Confirmed in first-party source; not needed for the new balance reading and not collected by this change. |
| Team plan, member usage and credit spending | SDK exposes team subscription, token-plan usage and credit-pool/spending queries | Source-confirmed capabilities, not live team acceptance. The current collector intentionally selects the personal workspace. |

Relevant 3.1.6 source paths under the extraction root:

- `dist/main/ipc/proxy.ipc.js`: auth origin/path allowlist and main-process Bearer injection.
- `dist/main/modules/auth/account-identity.js`: official account-info request.
- `dist/main/config/constants.js`: `agent.minimax.cn` / `agent.minimax.io` app origins, `www.minimaxi.com` / `platform.minimax.io` platform origins.
- `out/_next/static/chunks/12657-f1cf451ea1af2606.js`: workspace list, type-0 personal selection, membership body and default-workspace mutation.
- `out/_next/static/chunks/15233-5d11093edcfb09ea.js`: group header, balance, quota, usage, subscription and credit SDK methods.
- `out/_next/static/chunks/62596-96bed7660a34603f.js`: credit summary, detail pagination and personal-workspace usage behavior.

## OAuth state interoperability

Source: `node_modules/@mavis/oauth-core/dist/` (`namespace.js`, `state-store.js`, `auth-core.js`, `oauth-client.js`, `refresh-owner.js`, `credential-store/file-store.js`).

The official namespace is `auth/prod/{cn,en}/mcode-public`, with one current login in each namespace. Credential record keys identify the storage namespace, not different users. The required scope is fixed; it is not a general permission to use arbitrary origins. Official CN token exchange is `account.minimax.cn/oauth2/token`; the international origin is `account.minimax.io`.

The integration now reads the official state as well as the credential. Logout, anonymous, in-flight refresh and mismatched generations cannot expose a stale token. Before rotation it durably reserves `refreshing`, a next generation, UUID and process owner. Commit requires the same state transaction and credential lease, then publishes authenticated state last. Pending writes are bound to that transaction; they cannot roll back an official logout or fresh login. Lost/replaced locks are not used for commit or rollback.

Grant parsing follows the official compatibility cases: omitted refresh token retains the prior value; absent body scope may use JWT scope/scp metadata; Bearer type and a positive expiry are required. JWT metadata is not used to authenticate the token or identify an account. An unusable successful response invalidates the uncertain session rather than replaying a possibly consumed refresh token.

Token Monitor reuses its existing atomic writer and runtime pending state instead of implementing the official journal. A memory-only grant may still be lost on process crash. The durable fence ensures the official Core can recover a matching credential already committed to disk, or invalidate a dead owner without replaying its predecessor.

This was checked by executing the **extracted official** `AuthStateStore`, `FileStore` and `MCodeOAuthCore` against temporary fake credentials produced by the integration:

| Simulated outcome | Official reader/recovery result |
| --- | --- |
| Normal rotation | Fence schema accepted; authenticated generation 8; new lease readable without exchange |
| Credential commit fails, then owner ends | Fence schema accepted; anonymous generation 8; old refresh token never exchanged |
| Credential committed, authenticated-state write fails | Official recovery adopts committed generation 8 and returns the new lease without exchange |

Repro script: `/tmp/minimax-v316-official-compat.cjs`; safe result: `/tmp/minimax-v316-official-compat-evidence.json`. No real credential was used by this compatibility check.

## Settings and account scope

MiniMax uses the same descriptor-driven account panel and shell as Claude: status, source controls, explanatory note, conditional manual credential panel, and refresh. Its existing `minimaxBillingMode` key remains compatible, while the visible label is now **Data source** and Code is labeled automatic. Code reads plans, points and the API wallet from the current local login; API-key modes remain available for a different account or an installation without Code. Only safe display metadata reaches the renderer.

Claude's organization picker selects one organization inside a login; it is not a general multi-login manager. Similarly, a MiniMax team workspace is not another OAuth login. The shared Limits view can display multiple identified rows, but persistent simultaneous MiniMax login management would need a real credential lifecycle and selection model. This change keeps one selected source and the official current local login, preserving the saved API key for manual selection; it does not copy user tokens into a new account store.

Current live acceptance covers macOS / China / personal account with no M Plan and no purchased credits. International, Windows/Linux, paid-credit spending and team plans remain untested live. No purchase endpoint or workspace-default mutation was called.
