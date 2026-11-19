---
summary: "Alibaba Token Plan provider notes: the four console variants, Bailian CLI first with Cookie fallback, cookie scope, sec_token resolution, and which variants are verified."
ids: [alibaba]
read_when:
  - Adding or modifying the Alibaba Token Plan provider
  - Debugging an Alibaba cookie that saves but reports unauthorized or unavailable
  - Explaining Alibaba Token Plan setup or its verification status to users
---

# Alibaba Token Plan

Reads Token Plan quota from the Alibaba Cloud console. One provider id (`alibaba`), four console variants selected by `alibabaVariant`.

| Variant | Console | Plan | Quota endpoint | Windows |
|---|---|---|---|---|
| `cn` | `bailian.console.aliyun.com` | Team | `GetSubscriptionSummary` | account-level `billing` total |
| `intl` | `modelstudio.console.alibabacloud.com` | Team | `GetSubscriptionSummary` | account-level `billing` total |
| `cn-personal` | `bailian.console.aliyun.com` | Personal/Solo | `bailian-cs.console.aliyun.com` rolling-window API | `billing` (monthly), plus `session`/`weekly` when still reported |
| `intl-personal` | `modelstudio.console.alibabacloud.com` | Personal/Solo | `bailian-singapore-cs.alibabacloud.com` rolling-window API | `billing` (monthly), plus `session`/`weekly` when still reported |

The variant is one enum rather than separate site and plan settings because host, product code, gateway action and window shape all move together — two settings would let a user pick a combination that does not exist.

Account names, ordering and compact quota controls distinguish the four variants even when they share the same Alibaba account ID. Quota history continues to use the original account ID and variant.

## Verification status

Only `cn` has been exercised against a real account, from the capture reported on #567 and pinned in `tests/shared/alibabaLimits.test.js`. The other three are implemented from the same published console contract and covered by fixtures, but no one has confirmed them live. Treat a user report about them as authoritative over the fixtures.

## Auth

Refreshes first look for a native Bailian `bl` executable on PATH or in common install directories (`bl.exe` or a standard global npm installation on Windows). Windows npm installations use the fixed `node_modules/bailian-cli/dist/bailian.mjs` entry with `node.exe` found beside the shim or on PATH; the `.cmd` shim itself is never executed. No CLI is installed and no interactive login is started. The selected `alibabaVariant` still controls the region and plan type; neither is auto-detected.

- Personal/Solo reuses the CLI console login and calls `bl console call --api zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage --data '{}'` with the selected region and CLI site (`domestic` or `international`), plus JSON output. These CLI site values differ from the web gateway’s internal console identifiers. It reads the reported percentage windows, including monthly usage; absolute totals and tier metadata are unavailable through this path.
- Team requires read-only AK/SK configured with `bl auth login --open-api`, including `modelstudio:GetSubscriptionSeatDetails` (for example via `AliyunTokenPlanReadOnlyAccess`). Console login alone does not authenticate Team. `bl token-plan list-seats` is paginated and the active seats' current `CREDITS` cycles are aggregated. Resource packs and historical cycles are excluded. Different cycle ends have no single reset time.
- In Auto mode, missing CLI, failed login, or unusable CLI quota falls back to a console `Cookie` request header, pasted in the GUI or set through `ALIBABA_TOKEN_PLAN_COOKIE`. Cookie save-time validation always checks the submitted cookie alone. No model API-token path is supported.

Background CLI quota reads force `NO_UPDATE_NOTIFIER=1` and `DO_NOT_TRACK=1` to disable CLI update checks/automatic upgrades and telemetry. CLI calls have a shared 15-second budget per refresh, bounded output and closed stdin. Only config/home discovery (including `BAILIAN_CONFIG_DIR`), locale, timezone, absolute PATH directories and proxy variables are inherited; Team endpoints are fixed to the selected region. CLI networking uses its own proxy configuration/environment rather than the injected Electron HTTP transport. The app does not read or copy the CLI's credentials. In legacy default-account mode, if the CLI and Cookie belong to different accounts, the CLI wins when usable; saving a Cookie does not change the CLI login. With saved slots, CLI and Cookie owners are collected independently. A successful source switch replaces the previous local row rather than retaining both sources. CLI authentication and Team seat aggregation have fixture/subprocess coverage but have not been verified against a live Alibaba account.

The cookie is scoped to the console it was copied from, so switching variants clears the stored cookie rather than leaving one that can only answer `unauthorized`.

**Personal/Solo reads its quota from a different host than its dashboard.** Its cookie has to come from the `/tokenplan/personal/api/v2/usage` request, not from the dashboard page — the settings panel names the right request per variant. Team copies from the `GetSubscriptionSummary` request instead.

`sec_token` is resolved before the quota call, best effort, in this order: the console shell's HTML, `/tool/user/info.json`, then a `sec_token` cookie. Some accounts are rejected without it; plenty answer fine without one, so a missing token is never an error. The HTML hop sends navigation headers because the shell only server-renders the token for what looks like a real document navigation — Chromium strips the `Sec-Fetch-*` family from a `fetch()`, so under the widget transport that hop usually falls through to the JSON endpoint.

## Error mapping

The gateway answers HTTP 200 for authentication failures, permission failures and errors alike, carrying the real outcome in the body — sometimes in a JSON string nested inside the JSON, sometimes in an inner frame wrapped by a successful outer envelope. `parseConsoleBody` funnels every response through expansion, envelope inspection and login-HTML detection before any figure is read.

Two distinctions are load-bearing and should not be collapsed:

- A stale session (`Login.NotLogined`, a login HTML shell, HTTP 401/403) is `unauthorized`, so the UI tells the user to paste a fresh cookie. Everything else that fails is `unavailable`.
- `Workspace.NotAuthorised` is **not** a credential failure. Reporting it as one asks the user to replace a cookie that is already valid, and the replacement fails identically.

An empty subscription (`TotalCount: 0`), or a complete CLI seat list with no currently active seats, is a healthy, authorized account with nothing to draw: the row stays visible with no window.

## Scope and the provider id

This provider reads Token Plan. Alibaba's other console product, Coding Plan, is a separate product with its own quota endpoint and credential, and is deliberately not read here — the note exists so it is not added on the assumption that it was simply forgotten.

If it is ever added it belongs as extra windows under this same provider and cookie, since both plans live behind one Alibaba Cloud login, the way Volcengine carries its Coding and Agent plans together. That is why `alibaba` is a platform-level id rather than a plan-level one.

A plan-specific API key is an inference credential: it calls models, it does not read quota. It cannot replace either a console cookie or the Team CLI’s read-only AK/SK.

## What the Team figure is

Team quota is allocated **per seat**, not as one shared pool. The CLI path aggregates active seat credits; the Cookie path shows `TotalValue` / `TotalSurplusValue` from `GetSubscriptionSummary`, which is the account-level summary Alibaba's own My Subscriptions page headlines as its "overall quota usage percentage" — the same endpoint behind that page. The endpoint also returns `TotalCount`, which is read only to tell an empty subscription apart from a populated one; how it and the value fields behave on a multi-seat account has not been verified against a real one.

**This figure does not tell you whether a given seat can still call.** Alibaba's Team FAQ is explicit: "When the seat quota is exhausted, API calls are blocked and no pay-as-you-go charges apply." A seat that runs out continues only if the team has eligible shared usage pack quota left, and an admin can cap how much of that pack an individual member may draw. So on a multi-seat team, read this as overall base-plan usage across the account, never as one member's remaining callable quota.

## Personal windows

Alibaba's window set is not fixed. It originally defined 5-hour and 7-day windows, lifted the 5-hour cap "for a limited time", and later retired the weekly cap so that a current response carries only a monthly window (`per1MonthPercentage` / `per1MonthResetTime`, total from `quota-config[plan].monthly`). The parser reflects whatever the gateway reports rather than assuming a set — a monthly-only response produces a single `billing` window labelled "Monthly", and no placeholder rows are synthesized for windows that are absent.

## Known gaps

- **Base plan quota only.** Alibaba sells add-on quota on top of the base plan — an Extra Bundle for Personal and shared usage packs for Team — and both sit outside the base windows this provider reads. Neither is read here, so an account holding add-on credit can show a base window at 100% used while the service still answers. Treat a "used everything but it still works" report as this gap, not as a parsing bug.
- **Multi-seat Team distribution is not shown.** The CLI reads seats but publishes only their aggregate; the Cookie path reads only the account-level summary. No per-member breakdown is shown. Unverified against a real multi-seat account.
- **One selected plan per saved account.** Each saved cookie has its own `alibabaVariant`. Multiple saved accounts can cover Team and Personal on the same device; aggregation retains the full variant alongside the account id.
- **A row with no account id can be superseded.** The account id is read opportunistically from the Personal payloads. Team CLI seat responses supply no account id. An unidentified row can be dropped by shared aggregation when another device reports an identified row for the same provider; no cross-device account id is invented from the CLI path, credentials or plan tier. A plan label may identify the local runtime row without proving that two devices observe the same account.
- **An env cookie can be paired with a GUI-selected variant.** `ALIBABA_TOKEN_PLAN_COOKIE` is not cleared by changing the console in Settings, so the two can disagree. The result is a clean `unauthorized` from the newly selected console rather than wrong figures, so this is left as a documented sharp edge rather than a disabled control; set `ALIBABA_TOKEN_PLAN_VARIANT` alongside the cookie for headless installs.
- Personal/Solo reports percentages. Absolute totals appear only when the quota-config endpoint recognises the plan code.
- The Team figure is a token-value quota, not money, so its windows carry no `credits` metric and no currency.

## Saved accounts

Saved accounts retain their own console variant and cookie. Bailian CLI discovery remains in the default local lane; it cannot authenticate a different saved cookie or validate a cookie during save. Personal, Team and regional variants preserve their existing quota and history separation.

## Collection sources

Without saved slots, collection tries the Bailian CLI first and falls back to the Cookie. During provider-wide refreshes with saved slots, the snapshot reads the local CLI once while each saved/environment Cookie is queried independently through Web; a CLI login cannot authenticate another cookie. An account-scoped Cookie refresh skips CLI discovery; a retained CLI account refresh uses that account’s variant rather than a changed default. A confirmed CLI login replacement retires the previous CLI identity on a provider-wide refresh unless a successful Cookie reading still owns that identity and variant; temporary CLI failures retain its last quota. Pausing or removing a duplicate saved Cookie preserves the independently observed CLI quota and its last attempt status for the same account and variant, while confirmed CLI replacements relinquish the old ownership. Saved variants, region/product identities and cookie-only save probes remain unchanged.
