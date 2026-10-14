---
summary: "Manual-only Notion AI allowance: internal endpoints, explicit workspace selection, private account identity and fixture-only validation."
ids: [notion]
read_when:
  - Changing Notion AI account setup or allowance parsing
  - Debugging Notion workspace identity or credential handling
  - Explaining Notion AI support and its validation limits
---

# Notion AI

## Identity and ids

`notion` is a limits-only provider, not a tracked token client. The integration targets the per-user AI usage allowance of Business/Enterprise workspaces. Only fixtures have been validated; no real response sample is available, and live authentication remains pending explicit approval.

The workspace must be selected explicitly with `notionWorkspaceId`, a workspace UUID (`spaceId` in the allowance request), not a page ID. Dashed and undashed UUIDs normalize to the same identity. `getSpaces` must corroborate both the signed-in user ID and that exact workspace ID; it must not silently select a different workspace. The account key is a stable hash of user plus workspace, so the same user's separate workspaces remain distinct during cross-device aggregation. Email and workspace names are not displayed or used as identity signals.

## Data sources

The integration uses two internal POST endpoints at `https://app.notion.com`. Token Monitor implements its own parser and transport integration.

- `/api/v3/getSpaces`, with `{}`, supplies corroborated user/workspace records and subscription tier.
- `/api/v3/getCreditRateLimitStatus`, with `{ "spaceId": "<workspace UUID>" }`, supplies the allowance windows.

For product context, see Notion's official [Manage your usage allowance for Notion AI](https://www.notion.com/help/manage-your-usage-allowance-for-notion-ai). That help page is not a public API contract for these endpoints.

The parser accepts the fixture's `basic_ai_credits` / `per_user` shape. `window.window === '6h'` identifies the rolling allowance (`session`, 360 minutes); `resetsInSeconds` supplies its reset when present. `billingPeriodWindow.cadence === 'billing_period'` identifies the Monthly billing window; `periodEndMs` supplies its reset when present. Percentages come from the returned `used / limit`, not an assumed 100-unit limit. Missing reset fields remain unknown. No monthly `windowMinutes`, calendar duration or 30-day sentinel is invented from an end timestamp.

## Source precedence

An explicit saved/manual value precedes the environment fallback for each field. The cookie aliases are `TOKEN_MONITOR_NOTION_COOKIE`, then `NOTION_COOKIE`; workspace aliases are `TOKEN_MONITOR_NOTION_WORKSPACE_ID`, then `NOTION_WORKSPACE_ID`. Both fields are required. No browser, local Notion app, token-file or automatic workspace-discovery fallback is provided. Headless installs use the environment fields rather than the desktop credential store.

## Credentials and transport

The backend's require-free `account.js` declares `notionCookie` as a password control and `notionWorkspaceId` as a required plain-text control in the generic multi-field account form. GUI cookies live in the shared credential store at the declaration's `storePath`; renderer settings receive only a redacted marker. The workspace ID is configuration, not a secret. No provider-specific renderer save handler or credential store is needed.

Setup is manual: open [app.notion.com](https://app.notion.com/), select the intended Business/Enterprise workspace, open DevTools → Network and Settings → Notion AI → Usage, and inspect `getCreditRateLimitStatus`. Copy `token_v2` from its Cookie header and `spaceId` from its request payload. Paste both fields into the account form. A raw token, `token_v2=...`, or a Cookie header containing that pair is accepted; normalization forwards only `token_v2`. Full curl captures are not accepted.

Requests use the injected limits transport, `credentials: 'omit'`, and rejected redirects. There is no `Host` override or browser cookie harvesting. The UI opens only `https://app.notion.com/` for setup. Generic credential saves probe the exact submitted fields without borrowing a stored or environment credential; incomplete/invalid drafts and rejected sessions do not persist. HTTP authentication rejection is distinct from an unavailable endpoint or unknown response schema.

## Invariants and known gaps

- These are unsupported internal `/api/v3` endpoints with no public API guarantee. Their schema, eligibility and authentication can change; unknown responses fail as unavailable rather than guessed quota data.
- Fixture validation does not confirm live authentication, current plan eligibility or live enforcement states. Only `within_limit` yields readings; `not_applicable` and undocumented enforcement statuses return unavailable, never a guessed full quota. The generic save flow treats unavailable probes as indeterminate and can save the submitted pair without confirming eligibility. No real request, login or credential collection has been performed. Obtain approval before any live validation.
- The allowance's `basic_ai_credits` units are neither measured tokens nor a money balance. Do not attach the shared `credits` money metric, currency or token estimates to them.
- Custom Agents, Workers and premium-model credit pools are outside this integration. No credits-pool endpoint is queried or inferred from the per-user allowance.
- HTTP 401 and ordinary 403 reject the session; a 403 explicitly marked `cf-mitigated: challenge` is unavailable and preserves last-good readings through the shared runtime. Error bodies are never inspected or forwarded.
- One explicit cookie/workspace pair is configured per device. Distinct workspace accounts can be observed on separate devices; this does not add a multiple-workspace picker or automatic account import.
- Account identity requires verified user and workspace IDs. Never replace them with an email, a workspace name, the cookie value, or a fallback workspace selected from `getSpaces`.

## Verification

Run `node --test tests/shared/notionLimits.test.js tests/electron/notionIntegration.test.js` for the fixture parser and generic account integration. Registration, locale keys and docs are covered by the existing provider-order, i18n, vendor-presentation and README consistency checks; the final integration runs `npm run verify` after generated Worker/Hub metadata is refreshed.

A real sanitized response sample is still needed to validate live Business/Enterprise authentication and workspace selection. Any such check requires explicit approval and manually provided session credentials; fixture-only results must not be described as confirmed live support.
