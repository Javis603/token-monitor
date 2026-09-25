---
summary: "TypeSafe Console billing balance and token usage from separate authenticated data planes."
ids: [typesafe]
read_when:
  - Changing TypeSafe limits collection, Cookie handling, or spend presentation
---

# TypeSafe

## Data sources

The Billing page's `getBillingOverviewResult` Next.js action supplies the credit balance and plan. Its `spent` field is not the Usage page's estimated model spend: on a live account it reported zero while Usage displayed $0.0001. Never use it for the spend row.

`GET /api/usage?granularity=hour` supplies per-key input tokens, output tokens, and request counts in timestamped buckets. Range parameters are ignored — probing with `period=24h` still returned a three-day-old bucket — so the response is the account's recorded bucket history and every window is computed client-side from calendar days. The console's estimate is input tokens × `INPUT_TOKEN_COST_USD` + output × `OUTPUT_TOKEN_COST_USD`; those constants are scraped from the Billing page's JS chunks during the same scan that discovers the server-action ID (the bundle registers them via `t.s(["INPUT_TOKEN_COST_USD",0,gt,...])`), falling back to the last observed values of $0.042/MTok input and free output. The scraper does not resolve JavaScript scope, so rates outside the broad 0 to $0.001 per-token range are rejected before caching; a plausible but incorrect match remains possible. `usageSummary` is month-scoped (`period: 'month'`) with `todayTokens` and `weekTokens` (trailing seven days) as extra totals; the card mirrors the Spend row with a Today · Month token summary and keeps the month input/output/request breakdown plus the estimate in the tooltip. The month's estimate is also reported as `balance.monthSpend` so the credits meter can derive a fill percent against the balance, the same shape DeepSeek uses. The rate is a website assumption, not a billing charge or a guaranteed stable price. Usage stats may be delayed. Do not infer an all-time total or a quota reset from this dataset — bucket retention is unverified beyond what the account has recorded.

The Billing action's `resetsInDays` does not match the Console's credit-grant expiry date and must not be mapped to the balance window's `resetsAt`. Instead, `billing.credits[]` supplies each grant's remaining amount and `expiresAt`; the nearest valid future grant sets an `expiry` boundary on the balance window, so the card uses the shared `Expires Nd Nh` formatter and shows the amount affected. Missing, depleted, or invalid grants never produce an invented date. A single grant labeled "Monthly credit" does not establish that another grant will arrive next month.

## Credentials and transport

The GUI accepts a full `Cookie` header from an authenticated request to `console.typesafe.ai/settings/billing`, stored through the shared credential store. The same value can be supplied through `TOKEN_MONITOR_TYPESAFE_COOKIE` or `TYPESAFE_COOKIE`. A TypeSafe inference API key is not a Console session. Requests use the injected transport, set `credentials: 'omit'`, reject redirects, and send the header only to the fixed Console origin. The current server-action ID is discovered from Billing's same-origin scripts, cached for 12 hours, and rediscovered once when the server reports a stale ID.

## Invariants and known gaps

### Cloudflare

The Console sits behind a managed Cloudflare challenge that profiles the request, not the cookie: the same valid `Cookie` header is refused with a 403 interstitial unless the request also carries a browser's client hints (`sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `Accept-Language` alongside the shared `BROWSER_USER_AGENT`). Plain Node fetch and curl are refused even with the hints — their TLS fingerprints are flagged — while Electron `net.fetch` and macOS `URLSession` pass once the headers ride along. A challenge response is reported `unavailable` (`TYPESAFE_CF_CHALLENGE`), never `unauthorized`: the cookie is not dead, the transport was refused.


The balance and usage reads both have to succeed for an `ok` snapshot. A partial response is unavailable so the limits runtime can retain the last good result. A login landing, 401/403, or redirect is an expired session. The manually pasted Cookie can expire and the private Billing action can change; both require a new probe or code update. The monochrome mask follows the Console favicon's shape.

## Verification

Run `node --test tests/shared/typesafeLimits.test.js` and `npm run verify`. A live probe requires a current Console Cookie; the browser-only experiment established a $5 balance and 2,137 tokens from six requests but did not exercise Electron's injected transport.
