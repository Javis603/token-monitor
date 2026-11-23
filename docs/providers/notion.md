---
summary: "Manual Notion AI setup, personal credit allowances, legacy limits and private workspace identity."
ids: [notion]
read_when:
  - Changing Notion AI account setup or allowance parsing
  - Debugging Notion workspace identity or credential handling
  - Explaining Notion AI support and its validation limits
---

# Notion AI

## Identity and ids

`notion` is a limits-only provider for personal AI allowances in Business/Enterprise workspaces. Token Monitor validates the parser with fixtures and requires explicit approval for live authentication checks.

The workspace must be selected explicitly with `notionWorkspaceId`, a workspace UUID (`spaceId` in the allowance request), not a page ID. Dashed and undashed UUIDs normalize to the same identity. `getSpaces` must corroborate both the signed-in user ID and that exact workspace ID; it must not silently select a different workspace. The account key is a stable hash of user plus workspace, so the same user's separate workspaces remain distinct during cross-device aggregation. Email and workspace names are not displayed or used as identity signals.

## Data sources

The integration uses two internal POST endpoints at `https://app.notion.com`. Token Monitor implements its own parser and transport integration.

- `/api/v3/getSpaces`, with `{}`, supplies corroborated user/workspace records and subscription tier.
- `/api/v3/getCreditRateLimitStatus`, with `{ "spaceId": "<workspace UUID>" }`, supplies the allowance windows.

For product context, see Notion's official [Manage your AI credits](https://www.notion.com/help/manage-your-ai-credits). These endpoints are internal.

For migrated accounts, the endpoint can return personal monthly allowances in `allowances[]` even when the top-level legacy status is `not_applicable`. A uniquely identified, resolved `billing_period` entry for bucket `auto` supplies Standard credits and one for `flex` supplies Select credits. Each pool uses its own `credits.used`, `credits.limit` and, when present, `periodEndMs`. The app omits missing or invalid pools and displays the reported credit counts in the selected used or remaining mode.

If neither personal pool is usable, a valid legacy `within_limit` response can still supply Rolling and Monthly windows. The legacy `basic_ai_credits` / `per_user` shape uses `window.window === '6h'` for Rolling and `billingPeriodWindow.cadence === 'billing_period'` for Monthly. The rolling reset comes from `resetsInSeconds` and the monthly reset from `periodEndMs`. Missing reset fields remain unknown. Monthly windows carry the server's reset timestamp when available.

## Source precedence

An explicit saved/manual value precedes the environment fallback for each field. The cookie aliases are `TOKEN_MONITOR_NOTION_COOKIE`, then `NOTION_COOKIE`; workspace aliases are `TOKEN_MONITOR_NOTION_WORKSPACE_ID`, then `NOTION_WORKSPACE_ID`. Both fields are required. No browser, local Notion app, token-file or automatic workspace-discovery fallback is provided. Headless installs use the environment fields rather than the desktop credential store.

## Credentials and transport

The backend's require-free `account.js` declares `notionCookie` as a password control and `notionWorkspaceId` as a required plain-text control in the generic multi-field account form. GUI cookies live in the shared credential store at the declaration's `storePath`; renderer settings receive only a redacted marker. The workspace ID is configuration, not a secret. No provider-specific renderer save handler or credential store is needed.

Setup is manual: open [app.notion.com](https://app.notion.com/), select the intended Business/Enterprise workspace, open DevTools → Network and Settings → Notion AI → Usage, and inspect `getCreditRateLimitStatus`. Copy `token_v2` from its Cookie header and `spaceId` from its request payload. Paste both fields into the account form. A raw token, `token_v2=...`, or a Cookie header containing that pair is accepted; normalization forwards only `token_v2`. Full curl captures are not accepted.

Requests use the injected limits transport, `credentials: 'omit'`, and rejected redirects. There is no `Host` override or browser cookie harvesting. The UI opens only `https://app.notion.com/` for setup. Generic credential saves probe the exact submitted fields without borrowing a stored or environment credential; incomplete/invalid drafts and rejected sessions do not persist. HTTP authentication rejection is distinct from an unavailable endpoint or unknown response schema.

## Invariants and known gaps

- These are unsupported internal `/api/v3` endpoints with no public API guarantee. Their schema, eligibility and authentication can change; unknown responses fail as unavailable rather than guessed quota data.
- Without a usable personal pool or a valid legacy allowance, the provider reports unavailable. The generic save flow treats unavailable probes as indeterminate and can save the submitted pair before eligibility is confirmed.
- These are personal usage quotas. They use ordinary percentage meters and preserve the reported unit counts. The separate workspace-managed Notion Credits balance is outside this integration.
- HTTP 401 and ordinary 403 reject the session; a 403 explicitly marked `cf-mitigated: challenge` is unavailable and preserves last-good readings through the shared runtime. Error bodies are never inspected or forwarded.
- Each local account slot holds an explicit cookie/workspace pair. Existing fixed credentials migrate automatically, copying the workspace setting so environment credentials can still use it. Separate slots can track different users or workspaces; workspace discovery remains explicit and no automatic account import is provided.
- Account identity requires verified user and workspace IDs. Never replace them with an email, a workspace name, the cookie value, or a fallback workspace selected from `getSpaces`.

## Verification

Run `node --test --test-name-pattern=Notion tests/shared/notionLimits.test.js tests/electron/notionIntegration.test.js tests/electron/edgeDockLimitCard.test.js` to check parsing, account integration and the shared Limits and Edge Dock rows.

The personal allowance fixture uses the relevant fields from [CodexBar's sanitized response sample](https://github.com/steipete/CodexBar/blob/v0.85.0/Tests/CodexBarTests/Fixtures/Providers/Notion/get-credit-rate-limit-status-migrated.json). Token Monitor's live authentication and workspace selection still require separate validation with an approved session.
