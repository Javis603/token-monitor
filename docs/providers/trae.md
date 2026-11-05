---
summary: "Trae CN credit limits, browser-session authentication and legacy IDE-token compatibility."
ids: [trae]
read_when:
  - Changing Trae CN limits authentication or credit parsing
---

# Trae CN

## Credit limits

Use the signed-in Trae CN web dashboard session. In the widget, choose **Browser Cookie (recommended)** in the Trae CN account form. Open DevTools → Network, reload the dashboard, select a request to `api.trae.cn`, and copy the full **Cookie** request-header value. Paste that value and save. Browser sessions are shared on `.trae.cn`; a Local Storage `Cloud-IDE-Token` or the IDE's JWT file is not a browser Cookie. Automatic browser-cookie import is not supported.

The agent accepts `TRAE_COOKIE` or `TOKEN_MONITOR_TRAE_COOKIE`. Cookie authentication takes precedence over a legacy token. An expired session needs a fresh Cookie from the signed-in dashboard; a web authentication failure does not silently fall back to the IDE route.

The provider exchanges the Cookie for a JWT on every refresh, then requests current entitlements from the fixed `https://api.trae.cn` origin. Neither the exchanged JWT nor response cookies are persisted. Requests use the runtime-injected transport, reject redirects and omit its cookie jar. The Cookie remains a managed credential in the widget's shared credential store.

`usage_summary.total_amount` and `consumed_amount` are authoritative for the web route. Do not reconstruct them by summing entitlement packs, whose lifetimes and types differ. Remaining credits clamp at zero while reported overage is retained. Zero total credit has no percentage meter. Individual pack expiry/billing times do not establish an aggregate reset, so no reset time is inferred.

## Spend over time

Trae publishes one cumulative counter and no history: there is no dated usage endpoint
(`query_user_usage_group_by_session` returns zero rows for a normal account), no per-model
breakdown, and the local database is encrypted. Daily and weekly spend is therefore derived
from the counter itself — the rise between two polls is the spend in between, kept per local
day in `trae-credit-spend.json` under the shared data directory (60 days, bounded).

Consequences worth knowing: the first poll of a day only seeds that day's baseline, so a fresh
install reports zero until credits are actually consumed; the tail between the last poll of a
day and midnight is unobserved; and a counter that drops (plan reset or top-up) restarts the
day from the new value rather than reporting a negative spend. Token-level Trae usage is not
derivable from any source and is deliberately not fabricated.

## Legacy compatibility

Existing `traeAccessToken` / `traeDeviceId` settings and `TRAE_ACCESS_TOKEN` / `TRAE_DEVICE_ID` environment variables (including their `TOKEN_MONITOR_` aliases) retain the old `ide_user_ent_usage` route when no Cookie is configured. The account form also offers **Access token (legacy)**. Saving either authentication type replaces the other stored type; environment fallbacks remain independently configured.

The legacy endpoint can return 401 with an unexpired IDE JWT on newer Trae CN clients. Telemetry IDs are not evidence of the server-registered device ID used by the IDE. Prefer the web-session route; it does not need a device ID or the IDE's TTNet stack.
