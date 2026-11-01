---
summary: "Manus credits from a macOS/Windows desktop session or a manual web session on any OS: monthly and refresh allowances plus credits balance."
ids: [manus]
read_when:
  - Changing how the Manus desktop session is located or read
  - Changing Manus credits parsing or the dock/Limits rendering of its windows
  - Debugging a Manus card that shows Sign in, unavailable or stale credits
---

# Manus

## Identity and ids

`manus` is a limits-only provider, not a tracked token client: Manus does not expose per-request token counts, only a credits balance. The account key is a portable hash of the `user_id` claim in the desktop session, so the same account hashes identically on every device and token refreshes do not split it. The `email` claim is shown as the account label. When no `user_id` claim is present the key falls back to a hash of the session itself.

## Data sources

1. **Session.** A saved `manusSessionToken` or environment session takes precedence over desktop discovery. Accept a bare JWT or a Cookie header containing `session_id`; only that token is forwarded. The widget uses its shared credential store and account form. Headless collection accepts `TOKEN_MONITOR_MANUS_SESSION_TOKEN`, `MANUS_SESSION_TOKEN` or `MANUS_COOKIE`.
   - macOS: Manus Studio (`im.manus.desktop`, observed at 2.0.9) uses `~/Library/Application Support/Manus/Cookies`.
   - Windows: the official Store package (observed at 2.1.0, family `ManusAI.Manus_vajzd2mq3s8wj`) uses `%LOCALAPPDATA%/Packages/ManusAI.Manus_vajzd2mq3s8wj/LocalCache/Roaming/Manus/Network/Cookies`. The regular Electron profile at `%APPDATA%/Manus/Network/Cookies` is also checked.
   - [Manus has no official Linux desktop client](https://help.manus.im/en/articles/14089011-how-to-download-the-manus-desktop-app); use a manual web session on Linux.

   The desktop session is the host-only `session_id` cookie on `api.manus.im`. The observed macOS session is plaintext; the observed Windows binary disables Electron cookie encryption. Encrypted-only cookies report unavailable rather than attempting OS credential decryption. Databases are opened read-only with `node:sqlite`; on Windows a private temporary copy of the database and WAL avoids the running app's exclusive lock. Copies are removed after the read. Nothing is written back to Manus.
2. **Credits.** `POST https://api.manus.im/user.v1.UserService/GetAvailableCredits` with `{}`, `Connect-Protocol-Version: 1` and `Authorization: Bearer <session>`. This is the Connect RPC the desktop app's own account menu calls. It is **undocumented**: observed in the client bundle and confirmed with one read-only request against a signed-in account. There is no public API contract.

The response carries `totalCredits`, `freeCredits`, `periodicCredits`, `proMonthlyCredits`, `refreshCredits`, `maxRefreshCredits`, `nextRefreshTime` and `refreshInterval` (plus unrelated flags). The Manus web client maps `periodicCredits` to the remaining plan allowance and `proMonthlyCredits` to its ceiling.

## Windows

- When `proMonthlyCredits > 0`, a separate billing "Monthly" meter shows the remaining `periodicCredits`, clamped to its ceiling. No renewal date is supplied or inferred.
- When `maxRefreshCredits > 0`, the refreshing allowance becomes a quota window: `daily` (1440 minutes, "Daily") when `refreshInterval` is `daily`, otherwise a `billing` "Refresh" window. `remaining` is `refreshCredits` clamped to the ceiling, `used` is the rest, and `resetsAt` is `nextRefreshTime`.
- The spendable total is a `billing` window with `metric: 'credits'` and currency `CREDITS`, no meter and no reset, also reported as the provider balance. Manus credits are not money and never get a currency symbol.

Connect's JSON mapping omits zero-valued fields, so an absent count is read as zero. A body carrying none of the credit fields, or a non-numeric count, is an unknown shape and reports unavailable rather than zeros.

## Statuses

| Situation | Status |
|---|---|
| No manual session and no supported desktop cookie store or `session_id` cookie | `notConfigured` (Sign in) |
| Cookie value is not a JWT, or the API answers 401/403 | `unauthorized` |
| API answers 429 | `sourceRateLimited` |
| Store unreadable, `node:sqlite` missing, encrypted-only cookie, other HTTP errors, unknown body, timeout | `unavailable` |

## Invariants and known gaps

- Desktop discovery supports macOS and Windows. Linux supports the same manual web session and credits API.
- A saved or environment session selects that account; an API rejection never silently switches to a different desktop account. Clearing the manual session restores desktop discovery.
- Signing out of Manus only removes its desktop source; a separately saved web session remains configured until cleared or expired.
- If a future Manus build starts encrypting the cookie (`encrypted_value` only), the provider reports unavailable; it does not read the Keychain.
- The endpoint and its field names can change without notice. Unknown shapes fail closed.

## Verification

`node --test tests/shared/manusLimits.test.js` covers cookie discovery, a real SQLite/WAL snapshot, manual/environment session selection, monthly and refresh parsing (including omitted zero fields), the request shape and the HTTP status mapping, using the sanitized fixture `tests/fixtures/manusAvailableCredits.json` (invented values, real field names). `tests/electron/edgeDockLimitCard.test.js` renders the card. Registration, locale keys and docs are covered by the provider-order, i18n, vendor-presentation and README consistency checks.
