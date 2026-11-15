---
summary: "Mistral Vibe token accounting and Mistral web subscription allowances and credits."
ids: [mistral]
read_when:
  - Changing Mistral Vibe source roots or token accounting
  - Changing Mistral web credentials, subscription allowances or credit balance
---

# Mistral / Mistral Vibe

## Identity and ids

The tracked client id is `mistral`, shared with the model vendor and Mistral limits provider. The displayed client name is Mistral Vibe. Subprocess and custom-root scans map `mistral` to Tokscale's `vibe`; live usage, history and archives normalize `vibe` back to `mistral`. Watches target that same canonical partition. The existing Mistral artwork and `#FA520F` colour are reused.

## Data sources

Tokscale parses `$VIBE_HOME/logs/session/`, defaulting to `~/.vibe/logs/session/` on every platform. The watcher and source health check follow that same override; WSL discovery uses the Linux home-relative default.

Vibe 2.x records cumulative session statistics in `meta.json`; legacy flat JSON files wrap them under `metadata`. Tokscale reads those statistics rather than `messages.jsonl`. These are session-level counters, so the source cannot provide per-message token or model attribution. Timestamps and workspace attribution come from the scan.

Limits use a separate Mistral Admin web session. `GET https://admin.mistral.ai/subscription` supplies Included API and Vibe allowances from Next.js Flight budgets (`api_budget` and `vibe_budget`). Used and remaining amounts derive from the reported percentage and allowance size, not local Vibe token totals. Reset dates come from Mistral; no fixed monthly duration is assumed. API and Vibe Code each occupy a full-width quota row. The amount / allowance detail below each bar follows the used/remaining display mode, matching the other quota providers. Amounts are calculated from the reported percentage; the percentage-only Vibe fallback does not invent monetary totals.

`GET https://admin.mistral.ai/api/billing/credits` supplies the wallet plus credit notes minus ongoing usage. If the subscription page does not provide Vibe, a CSRF cookie enables the bounded fallback `GET https://console.mistral.ai/api-ui/trpc/billing.vibeUsage`. Each source is best-effort: one failure does not discard another valid quota or balance. Missing quota data is never treated as zero usage. Conflicting subscription budget records are rejected.

## Credentials and transport

Paste a full Cookie request header from Mistral Admin in Settings → AI Tool Limits → Mistral, or set `TOKEN_MONITOR_MISTRAL_COOKIE` (`MISTRAL_COOKIE` is an alias). An `ory_session_*` cookie is required; `csrftoken` enables the Vibe fallback. API keys and automatic browser-cookie retrieval are not supported. GUI credentials use the shared main-process credential store and never enter renderer settings.

Requests use the injected transport, omit browser-managed credentials and do not follow redirects. Only `ory_session_*` and `csrftoken` are forwarded to the console origin. The data sources do not expose a verified stable account id, so this integration does not claim cross-device account identity from rotating cookies.

## Invariants and known gaps

`session_prompt_tokens` already includes `session_cached_tokens`. Tokscale splits cached tokens out of input, and Token Monitor uses its normal additive input/output/cache accounting. Do not add cached prompt tokens to the original prompt total again.

## Verification

`node --test tests/shared/mistralLimits.test.js tests/electron/limitProviderWiring.test.js tests/electron/limitProviderOrder.test.js` covers quota parsing, optional-source failures, credential redaction, registration and transport. Fixtures follow the upstream schemas; live Mistral authentication still needs manual acceptance with a real account. API billing spend is not reconstructed by this limits integration.

`node scripts/verify-vendored-tokscale.js` exercises a nonzero Vibe metadata fixture against the selected binary and verifies both raw token buckets and normalized period/session totals. `node --test tests/shared/tokscaleUpstreamSources.test.js tests/shared/clientPartitionInvariants.test.js` checks source overrides, watch attribution and client partition identity.
