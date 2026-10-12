---
summary: StepFun platform quota from a browser Oasis-Token
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

The user copies `Oasis-Token` from a signed-in `platform.stepfun.com/plan-usage` browser request; it stays in main-process credential storage, and `STEPFUN_TOKEN` is the optional environment fallback. The cookie is a pair of JWTs joined by `...`: a short-lived access half (30 minutes in practice) and a long-lived refresh half (~30 days). The JWT refresh half provides the request's `oasis-webid` device ID.

When the access half expires, the fetcher calls the platform's own `POST /passport/proto.api.passport.v1.PassportService/RefreshToken` (connect-JSON, empty body, authenticated by the same cookie), combines the response's `accessToken.raw`/`refreshToken.raw` back into the cookie pair, retries the quota request once, and reports the rotation through `deps.onStepfunTokenRenewed` only after the quota retry succeeds — Electron persists it into the stored credential only while the setting still holds the token that was refreshed (a fresh paste mid-flight wins), and a save-time probe collects it into the draft instead. The server does not rotate the refresh half (the same stored token refreshes repeatedly), so a runtime without the callback (the agent) keeps working by refreshing from the stored value every poll. A renewal that cannot be persisted only costs one extra refresh on the next poll. The plan-name lookup and every retry use the effective token and the injected transport, credentials stay omitted, and the optional plan-name lookup keeps its own short deadline. Network failures, invalid refresh responses and HTTP 5xx remain unavailable, while HTTP 429 remains sourceRateLimited, so the shared runtime can retry and a save-time probe can retain an unconfirmed credential. HTTP 401/403 from refresh retains the unauthorized verdict. When the refresh half itself expires, no password login is attempted: the row reports unauthorized and the token needs replacing through settings. The account key hashes the refresh half, so rotating the access half does not change the account identity.

## Verification

`node --test tests/shared/stepfunLimits.test.js tests/shared/stepfunRefresh.test.js` covers plan detection, bucket weighting, token device ID, the refresh/retry flow, injected requests and failures. A signed-in StepFun account is needed to confirm the live endpoint and both plan variants.
