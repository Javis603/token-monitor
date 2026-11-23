---
summary: "CodingPass five-hour, weekly and monthly USD plan allowance and PAYG wallet from the codingpass.ai console API."
ids: [codingpass]
read_when:
  - Changing CodingPass limits collection, Cookie handling, or window presentation
---

# CodingPass

## Data sources

CodingPass has no API-key quota endpoint; the `x-ratelimit-*` response headers on inference requests are only reliable on a 429. The provider calls the same oRPC router the `codingpass.ai/app` console uses:

| Request | Purpose |
| --- | --- |
| `GET /api/auth/state` | Session check and identity. Answers 200 whether or not the session is live; only a live session carries `userId` |
| `POST /api/app/usage` (body `{"json":{}}`) | Plan caps (`quota`), live counters with reset times (`live.global`), and the subscription |
| `POST /api/app/wallet` (body `{}`) | Pay-as-you-go wallet balance and month spend; optional detail |

oRPC wraps successful answers as `{ json, meta }`. Every amount is USD micro-units (÷ 1,000,000), and counters can arrive as strings.

`live.global` layers (`global_5h`, `global_week`, `global_month`) carry the current counters and `resetAt`; `quota` carries the plan caps and the counters as of the last settlement. Live counters win and `quota` is the fallback for each field. A cap that is `null` or zero means the window has no limit, so the window is left out rather than drawn as an empty bar. The 5-hour window only starts on the first request: until `live.window5hStartAt` is set it has no reset time. The monthly window falls back to `quota.monthEnd` for its reset.

`live.models` lists each model's own layers (`model_5h`, `model_month`). On a live Plus account most models repeat the plan caps while a group of models carries smaller ones, two windows each for about twenty models. A model window becomes an `additional` row (`limitId` `codingpass.model.<modelKey>`, labelled with the model name) only while that model has less left than the plan window of the same kind. That is when it is the limit the user hits first; otherwise it would restate the plan once per model.

The windows are percentage meters with the USD pair under the bar (`limits/windowText.js`); they do not set `metric: 'credits'`, which is reserved for money balances. The wallet becomes a `credits` window plus `balance` only when it holds money or PAYG is on, so a plan-only account gets no `$0.00` row. The console displays the wallet converted by `rateBps` (basis points per USD) when set, and the provider applies the same rounding. A wallet failure never fails the reading.

## Credentials and transport

The GUI accepts the full `Cookie` request header from a signed-in `codingpass.ai/app` request, stored through the shared credential store; a multi-line `name=value` paste is joined into one header. `TOKEN_MONITOR_CODINGPASS_COOKIE` or `CODINGPASS_COOKIE` supply the same value. A CodingPass API key is not a console session. Requests use the injected transport with `credentials: 'omit'` and `redirect: 'error'`, send the Cookie only to `https://codingpass.ai`, and set `Origin` on POSTs (no `Referer`).

Account keys hash the session's `userId`, so the same account matches across devices and saved account slots; `isCodingpassServerAccountKey` tells that apart from the credential-hash fallback.

## Status mapping

A missing `userId` or a 401 is an expired session (`unauthorized`), which also refuses a pasted Cookie at save time. 429 is `sourceRateLimited`. Anything else — 403, 5xx, a redirect, or a changed response shape — is `unavailable`, so the last good reading is kept and the Cookie is not declared dead.

## Verification and known gaps

`node --test tests/shared/codingpassLimits.test.js` uses synthetic fixtures in the live response's shape. A live probe of a signed-in Plus account through Node `fetch` returned the three plan windows with their reset times and an empty, PAYG-off wallet (correctly omitted). An invalid Cookie got `/api/auth/state` 200 with `userId: null` and mapped to `unauthorized`. Electron's injected transport and macOS/Linux have not been exercised. How long a pasted console session stays valid is unverified.

This is an unofficial integration of an undocumented console API; a site update can break it.
