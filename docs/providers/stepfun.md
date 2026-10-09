---
summary: StepFun platform quota from a browser sign-in or a pasted Oasis-Token
ids: [stepfun]
read_when:
  - Changing StepFun authentication, plan detection, or quota windows
---

## Identity and ids

`stepfun` is a limits provider. Token Monitor does not collect StepFun token usage.

## Data sources

The StepFun platform's `QueryStepPlanRateLimit` response supplies the authoritative quota. A successful `GetStepPlanStatus` response adds the optional plan name. The Coding Plan has five-hour and weekly reset windows. The Token Plan uses `plan_credit_rate_limit` for a monthly credit percentage; its zero reset-time rate fields are inactive windows, not exhausted quotas.

## Source precedence

A live five-hour or weekly reset identifies the Coding Plan even if `plan_family` says otherwise. Without a live rate window, credit fields identify the Token Plan; `plan_family: 2` is the fallback. Complete credit buckets are weighted by `credit_total`; only a response without buckets falls back to the subscription rate, then the top-up rate. The two rates must never be added. Incomplete buckets, a missing credit rate, or a missing Coding Plan window return unavailable rather than a false percentage.

## Credentials and transport

Three lanes resolve in order: a pasted cookie string (token and `Oasis-Webid` together) is the manual override; a stored username + password drives the browser sign-in; `STEPFUN_TOKEN` / `STEPFUN_USERNAME` + `STEPFUN_PASSWORD` are the environment fallbacks. The password login cannot run over plain HTTP — the site's `GlobalPassportService` answers 403 to non-browsers behind a Volcengine WAF token that only clears once page JavaScript runs — so the app opens the real login page in a BrowserWindow on a session partition scoped to the username and reads the resulting Oasis cookies back inside the browser process. The partition persists unless "remember this login" is switched off, and Clear removes the cookies from every partition, not just the stored values.

The jar holds both an anonymous and a signed-in Oasis-Token, so neither "a cookie exists" nor "the cookie changed" is evidence of a session: `verifyStepfunSession` asks `GetStepPlanStatus` and the site's status code decides, in the cookie-reuse path and in the sign-in wait alike. A 200 body is exactly the plan-name lookup the probe wants next, so it rides along on the session and saves one request per probe. A 401 on the quota call triggers one re-login and retry. The sign-in window is never destroyed — on Electron 43.4 a destroyed window on a persistent partition takes the network stack down with it — so a failed sign-in is left on screen for the user to finish by hand. The optional plan-name lookup has its own short deadline so it cannot discard valid quota windows.

## Verification

`node --test tests/shared/stepfunLimits.test.js` covers plan detection, bucket weighting, token device ID, injected requests and failures. The sign-in split is covered by `tests/shared/stepfunLogin.test.js` (how limits asks for a token and what it does with the answer), `tests/electron/stepfunBrowserLogin.test.js` (the window flow against a fake page) and `tests/electron/stepfunMainSignIn.test.js` (main.js's signer: partition scoping, cookie reuse, Clear). A signed-in StepFun account is needed to confirm the live endpoint and both plan variants.
