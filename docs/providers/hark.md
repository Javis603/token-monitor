---
summary: "Hark account quotas from a macOS desktop session or a pasted session cookie."
ids: [hark]
read_when:
  - Changing Hark desktop session discovery or cookie handling
  - Changing billing summary parsing or quota presentation
  - Debugging missing Hark quotas or authentication failures
---

# Hark

## Identity and ids

`hark` is a limits-only provider. It has no local per-request token ledger, session history or model breakdown. Account identity hashes the decoded session token, so encoded and decoded spellings share one identity; a new login can change it and replaces the previous session reading. Plan labels use `plan.id` because the superscripts in `plan.name` are removed by the shared label sanitizer.

## Data sources

The macOS desktop session is `__Secure-hark.session_token` on `hark.com`, stored in `~/Library/HTTPStorages/com.harklabs.hark.mac.binarycookies`. This is WebKit's binary cookie store, not Chromium SQLite. Reads never modify it.

Quotas come from the undocumented `GET https://hark.com/api/billing/summary`. Although the client calls this query `billing.summary`, `/trpc/billing.summary` does not serve it. The response has been verified against a free account; paid plans have only been exercised with synthetic responses.

`meters.harkTokens` supplies the account-wide Daily ceiling and Monthly pool, including their reset times. Limits come directly from the summary; do not apply the multipliers shown by billing options. Amounts follow the shared used/remaining display setting, and reported usage may exceed the ceiling even though the bar stops at 100%.

Feature allowances appear only when `meters.perFeature` supplies a positive count or token ceiling. `plan.unlimited === true` suppresses quota meters. Enabled automatic top-up with positive `spentThisPeriodMinor` adds an unmetered USD spend line. Subscription dates, scheduled changes and gift metadata do not create quota windows.

## Source precedence

A saved `harkCookie` wins over `TOKEN_MONITOR_HARK_COOKIE`, then `HARK_COOKIE`, then desktop discovery. Other platforms support the same manual cookie but have no desktop discovery. A non-empty invalid credential or an API rejection never falls through to the desktop session. Clearing the saved cookie restores environment or desktop discovery.

Credential forms use the shared save validation: a rejected draft is not persisted and does not replace the existing account. The rejection appears in the panel; an existing desktop reading is not used to validate the draft.

## Credentials and transport

Accept a bare better-auth token or a Cookie header containing `__Secure-hark.session_token`. The desktop store percent-encodes its signature; a pasted token may be encoded or decoded. Validation and account identity use the decoded value, while requests forward the accepted spelling unchanged. Only this cookie is sent through the injected provider transport.

A missing desktop file or session cookie is `notConfigured`; an unreadable or malformed file is `unavailable`. HTTP 401/403 are `unauthorized`, and 429 is `sourceRateLimited`. Malformed summaries and other request failures are `unavailable`, retaining the last good reading through the shared runtime. A missing or negative Daily or Monthly ceiling makes the reading unavailable. An explicit zero ceiling omits that meter. A per-feature row without a positive ceiling is omitted and does not fail the rest of the summary. Invalid usage does not count as a successful reading. A rejected new session does not remove the previous account.

## Invariants and known gaps

Sessions are not renewed. After expiry, the account remains unauthorized until Hark writes a current desktop cookie or the user supplies one. Browser sessions are not intercepted.

## Verification

```bash
node --test tests/shared/harkLimits.test.js tests/shared/limitWindowText.test.js tests/electron/edgeDockLimitCard.test.js tests/electron/limitAccountPanels.test.js
```

The fixtures contain synthetic credentials. On a signed-in Mac, verify desktop discovery without pasting, compare both pools with the live summary, reject an invalid paste, then clear the override and confirm discovery resumes. Paid-plan API behavior still requires a real account sample.
