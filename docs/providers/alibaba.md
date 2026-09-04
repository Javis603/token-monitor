---
summary: "Alibaba Token Plan provider notes: the four console variants, cookie scope, sec_token resolution, and which variants are verified."
read_when:
  - Adding or modifying the Alibaba Token Plan provider
  - Debugging an Alibaba cookie that saves but reports unauthorized or unavailable
  - Explaining Alibaba Token Plan setup or its verification status to users
---

# Alibaba Token Plan

Reads Token Plan quota from the Alibaba Cloud console. One provider id (`alibaba`), four console variants selected by `alibabaVariant`.

| Variant | Console | Plan | Quota endpoint | Windows |
|---|---|---|---|---|
| `cn` | `bailian.console.aliyun.com` | Team | `GetSubscriptionSummary` | one `billing` pool |
| `intl` | `modelstudio.console.alibabacloud.com` | Team | `GetSubscriptionSummary` | one `billing` pool |
| `cn-personal` | `bailian.console.aliyun.com` | Personal/Solo | `bailian-cs.console.aliyun.com` rolling-window API | `session` (5h) + `weekly` |
| `intl-personal` | `modelstudio.console.alibabacloud.com` | Personal/Solo | `bailian-singapore-cs.alibabacloud.com` rolling-window API | `session` (5h) + `weekly` |

The variant is one enum rather than separate site and plan settings because host, product code, gateway action and window shape all move together — two settings would let a user pick a combination that does not exist.

## Verification status

Only `cn` has been exercised against a real account, from the capture reported on #567 and pinned in `tests/shared/alibabaLimits.test.js`. The other three are implemented from the same published console contract and covered by fixtures, but no one has confirmed them live. Treat a user report about them as authoritative over the fixtures.

## Auth

A console `Cookie` request header, pasted in the GUI or set through `ALIBABA_TOKEN_PLAN_COOKIE`. There is no API-token path.

The cookie is scoped to the console it was copied from, so switching variants clears the stored cookie rather than leaving one that can only answer `unauthorized`.

**Personal/Solo reads its quota from a different host than its dashboard.** Its cookie has to come from the `/tokenplan/personal/api/v2/usage` request, not from the dashboard page — the settings panel names the right request per variant. Team copies from the `GetSubscriptionSummary` request instead.

`sec_token` is resolved before the quota call, best effort, in this order: the console shell's HTML, `/tool/user/info.json`, then a `sec_token` cookie. Some accounts are rejected without it; plenty answer fine without one, so a missing token is never an error. The HTML hop sends navigation headers because the shell only server-renders the token for what looks like a real document navigation — Chromium strips the `Sec-Fetch-*` family from a `fetch()`, so under the widget transport that hop usually falls through to the JSON endpoint.

## Error mapping

The gateway answers HTTP 200 for authentication failures, permission failures and errors alike, carrying the real outcome in the body — sometimes in a JSON string nested inside the JSON, sometimes in an inner frame wrapped by a successful outer envelope. `parseConsoleBody` funnels every response through expansion, envelope inspection and login-HTML detection before any figure is read.

Two distinctions are load-bearing and should not be collapsed:

- A stale session (`Login.NotLogined`, a login HTML shell, HTTP 401/403) is `unauthorized`, so the UI tells the user to paste a fresh cookie. Everything else that fails is `unavailable`.
- `Workspace.NotAuthorised` is **not** a credential failure. Reporting it as one asks the user to replace a cookie that is already valid, and the replacement fails identically.

An empty subscription (`TotalCount: 0`) is a healthy, authorized account with nothing to draw: the row stays visible with no window.

## Coding Plan is deliberately not supported

Alibaba's other console plan, Coding Plan, is end-of-life: Lite stopped new purchases on 2026-03-20 and stopped renewals and upgrades on 2026-04-13, and Pro was a limited run that is not being restocked. Token Plan is the plan Alibaba sells and maintains. Adding a Coding Plan reader would mean carrying an unverifiable code path for a shrinking, one-way population, so `alibaba` covers Token Plan only.

This is why `alibaba` is a platform-level id rather than a plan-level one and still holds a single plan: there is no second live plan to widen it for. If Alibaba ships another console plan, it belongs as extra windows under this same provider and cookie, the way Volcengine carries its Coding and Agent plans together — not as a second provider.

Note that Token Plan's `sk-sp-` API key is an inference credential. It cannot read quota, which is why this provider is cookie-only.

## Known gaps

- Personal/Solo reports percentages. Absolute totals appear only when the quota-config endpoint recognises the plan code.
- Team quota is a token-value pool, not money, so its windows carry no `credits` metric and no currency.
