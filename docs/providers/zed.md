# Zed limits provider

Token Monitor reads Zed plan and Edit Predictions quota from Zed's authenticated account endpoint:

```text
GET https://cloud.zed.dev/client/users/me
Authorization: <user_id> <access_token>
```

This is separate from Zed token-usage collection through Tokscale. Zed-hosted Edit Predictions are reported here; BYOK models and external agents remain attributed to the provider that bills them.

## Credentials

Zed stores its own signed-in account in the operating system credential store and does not expose an app-owned `auth.json` equivalent. Token Monitor deliberately does not read macOS Keychain, Windows Credential Manager, Linux Secret Service, or browser cookies.

The desktop widget instead offers **Add Zed account**. It starts a loopback callback bound to `127.0.0.1`, creates an ephemeral RSA keypair, and opens Zed's native-app sign-in page in the user's browser. Zed returns the user ID and an encrypted access token to that callback. Token Monitor decrypts the token in the main process, verifies the account against `/client/users/me`, and only then commits the account metadata and credential. The private key exists only for that login attempt.

This follows the native-app sign-in protocol implemented by the current open-source Zed client: PKCS#1 DER public-key encoding, RSA OAEP-SHA256 token encryption, and the legacy PKCS#1 v1.5 decryption fallback. It is an integration with the current client protocol rather than a separately versioned third-party OAuth contract, so a future Zed protocol change may require a Token Monitor update.

The widget stores the Zed user ID as account metadata and the access token in Token Monitor's local `credentials.json`; raw credentials never enter the renderer settings payload. Headless installations can instead set `TOKEN_MONITOR_ZED_USER_ID` and `TOKEN_MONITOR_ZED_ACCESS_TOKEN`.

## Custom servers

`TOKEN_MONITOR_ZED_SERVER_URL` defaults to `https://zed.dev` and is intentionally an environment-only advanced setting; the widget does not show a server URL field. The value must be an HTTPS origin without credentials, a path, query, or fragment. For `https://zed.dev` and `https://staging.zed.dev`, Token Monitor sends the account request only to `https://cloud.zed.dev/client/users/me`. A custom server uses its own `/client/users/me` endpoint, so credentials are never forwarded across origins.

## Snapshot mapping

- `plan.plan_v3` becomes the plan label.
- `plan.usage.edit_predictions` becomes the primary Edit Predictions window. Finite plans use the reported `used` and `limit`; `unlimited` plans show a full meter with an explicit Unlimited value.
- `plan.subscription_period.started_at` and `ended_at` become a separate Billing cycle window. Its percentage represents elapsed time in the current subscription period, not token spend; the end timestamp is the reset/renewal date.
- `plan.has_overdue_invoices` adds an overdue Billing warning without replacing either quota window.

The Zed dashboard's Token Spend card is a separate data surface backed by its embedded metering provider. The authenticated account payload currently mapped here and by CodexBar does not provide that balance, so Token Monitor does not relabel Billing cycle progress as the plan's included token-credit usage.
