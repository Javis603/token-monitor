---
summary: "OpenDesign current-workspace subscription quotas using a manually supplied web session."
ids: [opendesign]
read_when:
  - Configuring or changing OpenDesign authentication, workspace identity or quota parsing
---

# OpenDesign

## Identity and ids

`opendesign` is a limits-only provider, without a tracked-client usage source.

## Data sources

The provider makes two read-only GET requests: `/api/v1/workspaces/current`, then `/api/v1/workspaces/{workspaceId}/billing/coding-plan-usage` with the matching `X-Vela-Workspace-Id` header. Only the discovered current workspace is read; workspaces are neither selected nor aggregated. Its hashed workspace ID owns the quota observations, so switching workspaces cannot inherit another workspace's history or reset dates. A failed discovery has no verified identity.

## Credentials and transport

OpenDesign reports the current workspace's five-hour and weekly subscription allowance. In Settings → AI Tool Limits → OpenDesign, paste the complete Cookie request header from a `coding-plan-usage` request to `amr-api.open-design.ai`, or set `TOKEN_MONITOR_OPENDESIGN_COOKIE` (`OPENDESIGN_COOKIE` is also accepted). Sign in at <https://open-design.ai/cloud/dashboard> and use DevTools → Network to obtain that header. Cookies are not imported automatically. Inference API keys cannot authenticate these billing endpoints.

## Invariants and known gaps

Windows are selected by duration (18000 / 604800 seconds), independent of array order. Subscription credits are allowance units, not money: they use ordinary session/weekly meters, without the monetary `credits` metric. Measured zero is retained; reset dates come only from valid reported timestamps. Ineligible plans, missing recognized windows, duplicates, invalid amounts or workspace mismatches report unavailable rather than an empty allowance. HTTP 401 maps to unauthorized access, HTTP 403 to unavailable access, and HTTP 429 to source throttling; these statuses do not establish the underlying cause. Requests use the injected transport, omit ambient credentials and reject redirects.


## Verification

Run `node --test tests/shared/opendesignLimits.test.js tests/electron/credentialCommands.test.js tests/electron/limitAccountPanels.test.js`.
