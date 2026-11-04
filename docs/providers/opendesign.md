---
summary: "OpenDesign current-workspace subscription quotas using a manually supplied web session."
ids: [opendesign]
read_when:
  - Configuring or changing OpenDesign authentication, workspace identity or quota parsing
---

# OpenDesign

OpenDesign reports the current workspace's five-hour and weekly subscription allowance. In Settings → AI Tool Limits → OpenDesign, paste the complete Cookie request header from a `coding-plan-usage` request to `amr-api.open-design.ai`, or set `TOKEN_MONITOR_OPENDESIGN_COOKIE` (`OPENDESIGN_COOKIE` is also accepted). Sign in at <https://open-design.ai/cloud/dashboard> and use DevTools → Network to obtain that header. Cookies are not imported automatically. Inference API keys cannot authenticate these billing endpoints.

The provider makes two read-only GET requests: `/api/v1/workspaces/current`, then `/api/v1/workspaces/{workspaceId}/billing/coding-plan-usage` with the matching `X-Vela-Workspace-Id` header. Only the discovered current workspace is read; workspaces are neither selected nor aggregated. Its hashed workspace ID owns the quota observations, so switching workspaces cannot inherit another workspace's history or reset dates. A failed discovery has no verified identity.

Windows are selected by duration (18000 / 604800 seconds), independent of array order. Subscription credits are allowance units, not money: they use ordinary session/weekly meters, without the monetary `credits` metric. Measured zero is retained; reset dates come only from valid reported timestamps. Ineligible plans, missing recognized windows, duplicates, invalid amounts or workspace mismatches report unavailable rather than an empty allowance. A 401 means an expired session; 403 is unavailable billing access, and 429 is source throttling. Requests use the injected transport, omit ambient credentials and reject redirects.

These are undocumented website endpoints. Validation uses synthetic fixtures; no live-account authentication or end-to-end provider acceptance has been performed. This source does not supply local per-model token or cost history.
