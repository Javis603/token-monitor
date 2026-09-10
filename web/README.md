# Token Monitor Web (optional)

A read-only, mobile-friendly Hub dashboard and installable PWA. This is the application UI, not the product website in `site/`. It is an independent Preact/TypeScript/Vite package: installing or packaging the desktop app does not install or build Web.

## Run locally

Requires Node.js 22.15+ and a running Node or Worker Hub with a configured secret.

```sh
npm ci --prefix web
cp web/.env.example web/.env
chmod 600 web/.env
# Edit web/.env in your editor: set TOKEN_MONITOR_SECRET to the Hub's secret.
npm run web:build
npm run web
```

Open `http://127.0.0.1:4174`. The default `WEB_AUTH_MODE=local` only binds to loopback and validates both the peer and Host header. Cross-site browser requests are rejected. The Hub bearer is used server-side, never embedded in a browser bundle, URL or localStorage. No additional login is needed on the trusted local machine. Use proxy mode for remote access, not port forwarding of local mode.

`HUB_URL` can point to either Hub implementation; defaults to `http://127.0.0.1:17321`. `GATEWAY_PORT` defaults to `4174`. Run from the `web/` working directory when starting `node dist-server/server/index.js` directly. The root `npm run web` command does this automatically.

## Configurable authentication

The Node server hosts static assets and proxies the read-only Hub API. `WEB_AUTH_MODE` selects exactly one browser authentication mode. The Hub bearer remains a separate server-to-server credential; it is never the Basic password or an OIDC credential. API clients can use their existing Hub bearer for the read-only routes. Enable the separate client channel below for Desktop/agent uploads.

### Sharing the URL with Desktop and agents

Set `WEB_ALLOW_HUB_CLIENTS=1` to let Desktop/agents use the same base URL as the
browser, for example `https://monitor.example.com`. The default is off, preserving
the read-only proxy behavior of existing deployments. Keep the existing Hub token
in the client's protected settings; do not put it in a URL or browser storage.

For `/api/` requests, an explicit `Authorization: Bearer ...` selects the client
channel before browser authentication. It is forwarded unchanged to the configured
Hub, which validates it. An invalid Bearer never falls back to an OIDC/Basic/proxy
session or the Web server's stored Hub credential. Cookies and proxy identity
headers are not forwarded. Client requests do not create Web sessions; browser
logout does not revoke a separate Hub token or its SSE connection.

The client allowlist includes the existing read routes, `POST /api/ingest`,
`PUT /api/subscriptions`, and `DELETE /api/devices/:id`. Request bodies stream to
the Hub; its payload limits and validation still apply. Hub tokens retain their
existing permissions (including device deletion and subscription writes), not
per-device write-only scopes. The proxy does not redirect requests to another
upstream or expose arbitrary paths. Client SSE uses the same cancellation and
backpressure handling as browser SSE.

Without an explicit Bearer, the selected browser authentication mode and read-only
allowlist remain unchanged. Cross-site request and local-mode restrictions still
apply to both channels. An upstream browser-only login wall must not intercept the
client API before it reaches Web; application-owned OIDC needs no separate domain.


Use a **dedicated origin**: assets, authentication endpoints and PWA scope are root-relative. A path-prefix deployment is not supported. For public HTTPS deployments, preserve the original Host header and disable buffering on `/api/stats/stream`.

### Local (default)

`WEB_AUTH_MODE=local` restricts the listener and browser requests to loopback, validates Host, and rejects cross-site API reads. The local machine is the trust boundary. There is no meaningful logout from local-machine trust.

### Basic

Set `WEB_AUTH_MODE=basic`, `WEB_PUBLIC_ORIGIN=https://monitor.example.com`, `WEB_BASIC_USERNAME`, and `WEB_BASIC_PASSWORD` in the protected server environment. The browser receives a standard HTTP Basic challenge; successful authentication creates a server-side Web session. Configure HTTPS termination before exposing this mode. Plain HTTP is permitted only for a loopback public origin during development.

Credentials are compared as exact UTF-8 bytes using `timingSafeEqual` after checking byte lengths; no password hash is stored or generated. After 20 failed attempts, further Basic authentication is denied until the one-minute window expires, even if the next password is correct. Failed attempts are rate-limited per socket peer (the server does not trust arbitrary forwarded IPs). When proxied, this means the limit is shared by that proxy. The browser may retain HTTP Basic credentials after application logout and reuse them on a subsequent login; close a private browsing window to discard browser-held credentials.

### OIDC (Web-managed login)

Set `WEB_AUTH_MODE=oidc`, `WEB_PUBLIC_ORIGIN`, `WEB_OIDC_ISSUER` (HTTPS), `WEB_OIDC_CLIENT_ID`, and optionally `WEB_OIDC_CLIENT_SECRET` (confidential client). Register **`WEB_PUBLIC_ORIGIN/auth/callback`** as the exact redirect URI with your identity provider. A public client uses PKCE without a client secret. Set `WEB_OIDC_ALLOWED_SUBJECTS` to a comma-separated subject allowlist if not all users of that issuer should access this Hub; omission trusts authenticated users of the configured issuer.

The server uses `openid-client` for discovery, authorization code + S256 PKCE, state/nonce checks, issuer/audience/expiry checks and ID-token signature verification via JWKS. Login transactions expire after ten minutes and are single use. Tokens remain server-side during the exchange and are not persisted in browser storage. No issuer URL is derived from request headers. `/auth/login` starts login; `/auth/callback` completes it. Provider failures are returned without raw tokens or response bodies.

Logout ends the **Web session**, not the identity-provider SSO session. A later login may reuse provider SSO. This version does not implement provider-wide logout or OIDC back-channel logout.

### Trusted Proxy

Set `WEB_AUTH_MODE=trusted-proxy`. `WEB_TRUSTED_PROXY_PEERS` is a comma-separated list of exact socket IPs/CIDRs (default `127.0.0.1,::1`). The source socket, **not X-Forwarded-For**, determines trust. Keep the listener inaccessible to other clients.

- **`WEB_TRUSTED_PROXY_MODE=header` (default):** require a nonempty authenticated identity in `WEB_TRUSTED_PROXY_HEADER` (default `x-forwarded-user`). The proxy must authenticate requests, remove caller-supplied identity headers, and inject its own verified identity. Requests without identity or a Web session are denied.
- **`WEB_TRUSTED_PROXY_MODE=external` (explicit auth offload):** for proxies that perform OIDC/Basic authentication but do not forward identity. Require `WEB_PUBLIC_ORIGIN` and protect both **`/` and `/index.html` upstream**, including requests with query strings. Only these exact entry paths can issue a Web session. Static assets, manifest and service worker may bypass upstream login; SPA fallbacks and encoded path aliases never issue sessions. The Web server only accepts the configured Host from trusted proxy sockets, and issues a Web session only when serving those protected entry paths. Anonymous API calls are still denied; `/api/*` can bypass upstream login redirects because this server checks a Web session or Hub bearer. There is deliberately no implicit fallback from header to external mode. Do not enable external mode behind a plain unauthenticated reverse proxy.

`WEB_AUTH_MODE=proxy` and legacy `TRUST_OIDC_PROXY=1` remain aliases for trusted-proxy header mode when the new configuration is absent.

For both proxy modes, configure `WEB_PUBLIC_ORIGIN=https://monitor.example.com` with the browser-facing origin: scheme, hostname and optional non-default port, without a path or trailing slash. This enables exact Origin validation, including the scheme, and Host validation. Do not use the proxy-to-Web HTTP listener address or derive this value from forwarded headers.

Header mode (including the legacy aliases) still starts without this setting for compatibility, but emits a migration warning: its host-only Origin fallback cannot distinguish HTTP from HTTPS on the same host. Add the setting to the existing server environment and restart the Web service; proxy identity headers, peer restrictions and authentication mode remain unchanged. There is no automatic switch to external mode and no removal deadline in this release. Basic, OIDC and external proxy modes already require this setting.

### Sessions and logout

All authenticated browser modes use an opaque `tm_web_session` cookie, `Path=/; HttpOnly; SameSite=Lax; Secure` on HTTPS. Sessions are server-owned, expire after eight hours, and are revoked immediately by `POST /auth/logout` (same-origin required). Existing SSE connections bound to that session are disconnected on expiry/logout. Restarting the server revokes all sessions; multi-replica session sharing is not implemented. `GATEWAY_SESSION_SECRET` is a legacy setting and is no longer used to sign browser cookies.

The settings menu's Sign out action clears this application's offline caches, unregisters its service worker, and opens the signed-out page. Other upstream SSO sessions and browser-cached Basic credentials are outside the Web session boundary. Hub bearer clients are not browser sessions and are not revoked by browser logout.

The server forwards only GET/HEAD on health, stats, devices, history and subscriptions, plus GET SSE. It never forwards ingest, subscription updates or device deletion. Neither the Hub nor desktop authentication contracts change.

## Display and offline behavior

- Live mode fetches a snapshot and subscribes to SSE, with reconnect and visibility handling.
- Snapshot mode closes SSE and freezes the current data; a cold start fetches once, and refresh is manual.
- Language defaults to the browser (English or Simplified Chinese); theme follows the OS. Language, theme and data mode persist in localStorage. Explicit choices override system changes.
- Unconfigured/disabled quota providers are hidden, Spark is collapsed, and missing values are not shown as zero. Provider names come from the main repository's shared catalog at build time.
- Balance is not a quota progress percentage. OpenRouter management-key spending is not account spending; DeepSeek observed spending is labeled as an estimate.
- Offline snapshots deliberately persist a whitelisted subset of usage/limits in browser Cache Storage. They remain accessible offline on that browser, including after upstream logout; the Web Sign out action clears its offline caches, or clear site data manually to remove them. Credentials and account identifiers are not saved in the snapshot. Cache cleanup touches only this application's namespaced caches. Provider free-text window fields (`detail` and `resetDescription`) are intentionally omitted: online descriptions may be absent offline. Numeric usage, limits, remaining percentages and reset timestamps are retained; adding an explanation to the online view does not implicitly authorize persisting it. Necessary additional offline semantics should use explicitly reviewed structured fields rather than caching arbitrary provider text.

## Development and verification

```sh
npm run web:verify
npm run web:build
npm run demo --prefix web
```

The demo is synthetic and clearly marked. It does not fetch Hub data or register a service worker; use it for screenshots. A production build excludes the demo branch. For live development, start the local-mode gateway first, then `npm run dev --prefix web`; Vite proxies `/api` to loopback without manufacturing an authenticated identity.

Web CI installs only this package and runs tests, typechecking and a production build on Node 22 and 24. Root `npm run verify` and existing desktop/Hub/Worker builds remain independent. No compiled assets are committed; `web/dist` and `web/dist-server` are build outputs.

The Web adapter consumes the existing `/api/stats` contract and is tested against the actual Node Hub. It does not collect credentials, parse agent logs, or modify shared aggregation rules. Node Hub contract tests are included; a real Cloudflare deployment is not part of the test suite.
