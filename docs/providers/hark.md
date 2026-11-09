---
summary: "Hark Pro quota from the macOS desktop session or a pasted session cookie. Account-level daily and period token pools, not a local token ledger."
ids: [hark]
read_when:
  - Changing how the Hark desktop session cookie is located or read
  - Changing Hark billing summary parsing or which windows a plan produces
  - Debugging a Hark card that shows Sign in, unavailable, or only a plan name
---

# Hark

## Identity and ids

`hark` is a limits-only provider. Hark does not write per-request token counts to disk, and the desktop shell does not implement billing. The account key is a hash of the session cookie, so a refresh that keeps the same token stays one account. The plan label comes from `plan.id` (`Hark Pro`, `Hark Pro 2`, `Hark Pro 3`, `Hark Pro 4`). `plan.name` uses a superscript the shared label sanitizer would delete.

## Data sources

1. **Session.** A saved `harkCookie`, `TOKEN_MONITOR_HARK_COOKIE`, or `HARK_COOKIE` wins. A non-empty value that is not `__Secure-hark.session_token` is `unauthorized` and does not fall through to the desktop file. The value is a better-auth token (`id.base64signature`). The macOS store keeps the signature percent-encoded; a paste may be encoded or decoded, and the accepted spelling is forwarded unchanged. With no pasted value, macOS reads `~/Library/HTTPStorages/com.harklabs.hark.mac.binarycookies` for that one cookie on `hark.com`. The file is WebKit's binary cookie store, not a Chromium sqlite database. It is opened read-only and nothing is written back. Other platforms have no desktop store; paste the cookie. A missing file or cookie is `notConfigured`. A file that cannot be parsed is `unavailable`.
2. **Quota.** `GET https://hark.com/api/billing/summary` with only that cookie. This is the Go API the desktop page calls as `billing.summary`. It is not on `/trpc`. Confirmed with one read-only request against a free account. Paid, trial, gift, store, and top-up responses use the same URL; those branches are what the shipped client reads, not a second sample.

## Source precedence

Pasted or environment cookie, then the macOS desktop file. A rejected paste does not continue. `401` and `403` are `unauthorized`. Anything else that is not a usable summary is `unavailable` and keeps the last good card.

## Windows

`plan.unlimited === true` leaves the plan name and no meters. Otherwise `meters.harkTokens` is a Daily window (`dailyUsed` / `dailyLimit` / `dailyResetsAt`) and a Monthly window (`poolUsed` / `poolLimit` / `poolResetsAt`) when each ceiling is greater than zero. The pool is what Hark's own client labels monthly. Do not multiply a free ceiling by the 2× / 10× / 20× badges on `POST /api/billing/options`; those are prices, not the summary.

`meters.perFeature` is empty on the free plan. A row with `countLimit` or `harkLimit` above zero becomes its own window. `autoTopup.spentThisPeriodMinor` becomes a meter-less Top-up spend line only when top-up is enabled and the amount is greater than zero. `subscription.currentPeriodEnd` is not a window.

## Invariants and known gaps

The desktop shell has no billing code. Session renewal (`GET` then `POST /api/auth/get-session` when `needsRefresh` is set) is not replayed here. A cookie lasts about 30 days; after that the summary returns unauthorized until Hark writes a new one or the user pastes one. There is no per-request, per-model, or per-day token ledger.

## Verification

```bash
node --test tests/shared/harkLimits.test.js
```

A signed-in Mac can confirm the live summary still has `plan` and `meters.harkTokens`. A paid account has not been sampled.
