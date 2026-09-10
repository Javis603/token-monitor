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

## Remote deployment behind authentication

Use a **dedicated origin**, such as `https://monitor.example.com`. Deploying below a path prefix or on the same origin as `site/` is not supported in this first version: assets, API routes, PWA scope and offline navigation are root-relative. Nothing is deployed to GitHub Pages by this package.

Set `WEB_AUTH_MODE=proxy` and provide an independent random `GATEWAY_SESSION_SECRET` of at least 16 characters in the protected environment file. Place the listener behind your existing authenticating reverse proxy:

- The proxy must authenticate **all non-API paths**, including `/`, `/index.html`, `/sw.js`, manifest, assets and SPA fallbacks. It must strip user-supplied `x-forwarded-user` and inject a nonempty authenticated identity. An anonymous shell request never receives a Web session.
- Only the trusted proxy may reach the listener. Prefer loopback; if binding a private/container interface, firewall it from other callers. This application does not authenticate the proxy's identity header itself.
- The gateway issues a signed, seven-day `HttpOnly; Secure; SameSite=Lax` cookie scoped to `/api`. `/api/*` may bypass the upstream login redirect so API clients and SSE get JSON responses; the gateway still requires a valid cookie, Hub bearer or trusted identity.
- Configure streaming without buffering on `/api/stats/stream` and preserve the original Host header. Serve HTTPS. Do not expose a cross-origin CORS bridge.

There is no built-in password database or identity-provider dependency. Configure login/logout at your authentication proxy. Rotate the session-signing secret to revoke all Web cookies; signing out of an upstream identity provider does not independently revoke already-issued Web cookies. The legacy `TRUST_OIDC_PROXY=1` spelling is accepted when `WEB_AUTH_MODE` is absent.

The proxy forwards only GET/HEAD on health, stats, devices, history and subscriptions, plus GET SSE. It never forwards ingest, subscription updates or device deletion. Neither the Hub nor desktop authentication contracts change.

## Display and offline behavior

- Live mode fetches a snapshot and subscribes to SSE, with reconnect and visibility handling.
- Snapshot mode closes SSE and freezes the current data; a cold start fetches once, and refresh is manual.
- Language defaults to the browser (English or Simplified Chinese); theme follows the OS. Language, theme and data mode persist in localStorage. Explicit choices override system changes.
- Unconfigured/disabled quota providers are hidden, Spark is collapsed, and missing values are not shown as zero. Provider names come from the main repository's shared catalog at build time.
- Balance is not a quota progress percentage. OpenRouter management-key spending is not account spending; DeepSeek observed spending is labeled as an estimate.
- Offline snapshots deliberately persist a whitelisted subset of usage/limits in browser Cache Storage. They remain accessible offline on that browser, including after upstream logout; use a private browser profile or clear site data to remove them. Credentials and account identifiers are not saved in the snapshot. Cache cleanup touches only this application's namespaced caches.

## Development and verification

```sh
npm run web:verify
npm run web:build
npm run demo --prefix web
```

The demo is synthetic and clearly marked. It does not fetch Hub data or register a service worker; use it for screenshots. A production build excludes the demo branch. For live development, start the local-mode gateway first, then `npm run dev --prefix web`; Vite proxies `/api` to loopback without manufacturing an authenticated identity.

Web CI installs only this package and runs tests, typechecking and a production build on Node 22 and 24. Root `npm run verify` and existing desktop/Hub/Worker builds remain independent. No compiled assets are committed; `web/dist` and `web/dist-server` are build outputs.

The Web adapter consumes the existing `/api/stats` contract and is tested against the actual Node Hub. It does not collect credentials, parse agent logs, or modify shared aggregation rules. Node Hub contract tests are included; a real Cloudflare deployment is not part of the test suite.
