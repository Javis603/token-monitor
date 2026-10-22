---
summary: "Automatic Manus credits from the signed-in Manus desktop app: local session cookie, undocumented Connect RPC, daily refresh window plus credits balance."
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

1. **Session.** Manus Studio (`im.manus.desktop`, observed at 2.0.9) is an Electron app whose Chromium profile lives in `~/Library/Application Support/Manus/`. Its API session is the host-only `session_id` cookie on `api.manus.im`, a JWT stored as a plaintext cookie value (no `Manus Safe Storage` Keychain item is involved). Token Monitor opens `Cookies` read-only with `node:sqlite` and selects only that host and name. Nothing is written back, and the token never leaves the process except as the request's bearer.
2. **Credits.** `POST https://api.manus.im/user.v1.UserService/GetAvailableCredits` with `{}`, `Connect-Protocol-Version: 1` and `Authorization: Bearer <session>`. This is the Connect RPC the desktop app's own account menu calls. It is **undocumented**: observed in the client bundle and confirmed with one read-only request against a signed-in account. There is no public API contract.

The response carries `totalCredits`, `freeCredits`, `refreshCredits`, `maxRefreshCredits`, `nextRefreshTime` and `refreshInterval` (plus unrelated flags). In the observed sample `totalCredits = freeCredits + refreshCredits`.

## Windows

- When `maxRefreshCredits > 0`, the refreshing allowance becomes a quota window: `daily` (1440 minutes, "Daily credits") when `refreshInterval` is `daily`, otherwise a `billing` "Refresh credits" window. `remaining` is `refreshCredits` clamped to the ceiling, `used` is the rest, and `resetsAt` is `nextRefreshTime`.
- The spendable total is a `billing` window with `metric: 'credits'` and currency `CREDITS`, no meter and no reset, also reported as the provider balance. Manus credits are not money and never get a currency symbol.

Connect's JSON mapping omits zero-valued fields, so an absent count is read as zero. A body carrying none of the credit fields, or a non-numeric count, is an unknown shape and reports unavailable rather than zeros.

## Statuses

| Situation | Status |
|---|---|
| Not macOS, no cookie store, or no `session_id` cookie | `notConfigured` (Sign in) |
| Cookie value is not a JWT, or the API answers 401/403 | `unauthorized` |
| API answers 429 | `sourceRateLimited` |
| Store unreadable, `node:sqlite` missing, encrypted-only cookie, other HTTP errors, unknown body, timeout | `unavailable` |

## Invariants and known gaps

- macOS only. The Windows and Linux userData locations have not been observed, so those platforms report notConfigured instead of guessing a path.
- No settings panel and no stored credential: the desktop app is the only source. Signing out of Manus Studio removes the cookie and the card returns to Sign in.
- If a future Manus build starts encrypting the cookie (`encrypted_value` only), the provider reports unavailable; it does not read the Keychain.
- The endpoint and its field names can change without notice. Unknown shapes fail closed.

## Verification

`node --test tests/shared/manusLimits.test.js` covers the cookie reader with a fake store, parsing (including omitted zero fields), the request shape and the HTTP status mapping, using the sanitized fixture `tests/fixtures/manusAvailableCredits.json` (invented values, real field names). `tests/electron/edgeDockLimitCard.test.js` renders the card. Registration, locale keys and docs are covered by the provider-order, i18n, vendor-presentation and README consistency checks.
