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

The user copies `Oasis-Token` from a signed-in `platform.stepfun.com/plan-usage` browser request. It stays in main-process credential storage; `STEPFUN_TOKEN` is the optional environment fallback. The JWT refresh half provides the request's `oasis-webid` device ID. Every request uses the injected transport and omits browser credentials. The optional plan-name lookup has its own short deadline so it cannot discard valid quota windows. This initial integration does not perform password login or persist a rotated Oasis token, so an expired token needs replacing through settings.

## Verification

`node --test tests/shared/stepfunLimits.test.js` covers plan detection, bucket weighting, token device ID, injected requests and failures. A signed-in StepFun account is needed to confirm the live endpoint and both plan variants.
