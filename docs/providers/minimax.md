---
summary: MiniMax Token Plan region selection and endpoint fallbacks
ids: [minimax]
read_when:
  - Changing MiniMax region selection, credentials, or quota endpoint fallbacks
---

## Source precedence

An explicit `minimaxApiRegion` choice wins over the legacy probe option `minimaxApiHost`, then `TOKEN_MONITOR_MINIMAX_API_REGION`, `MINIMAX_API_REGION`, and `MINIMAX_API_HOST`. Region and hostname aliases are exact matches. The default is `auto`: probe the last region that returned parseable quota first, or international first when no success is remembered. The other region remains a fallback for authentication rejection or transport failure. A China/International selection from settings or env always pins that region ahead of memory and prevents cross-region requests.

Within each region, the Token Plan endpoint falls back to the legacy Coding Plan endpoint on the existing migration/error signals. A transport failure skips the remaining endpoint on the unreachable host. Runtime cancellation stops the probe without retrying another region; a per-request timeout remains eligible for fallback. HTTP failures such as 5xx or 429 and JSON parse failures do not trigger a cross-region retry.

## Credentials and transport

The API key stays in the main-process credential store. Region changes retain the key, clear the old quota, and immediately refresh only MiniMax through the normal settings invalidation path. Calls use the injected transport and fixed MiniMax API URLs.

If the fallback region rejects the key after a transport failure, report `unavailable` so the runtime retains the last known quota instead of prompting for a replacement key. When every attempted region rejects the key without a transport failure, report `unauthorized`.

## Invariants and known gaps

An unchosen region stays empty in stored settings. Renderer projection and runtime config resolve the environment at use time; displaying Auto or saving a key must not freeze an implicit default. An explicit Auto selection is stored as `auto` and overrides the environment. The form's region saves independently (`submitWithCredential: false`); writes are serialized per field, and key submission waits for queued writes and omits the region from its credential draft. Failed writes show a panel message and leave the queue so later submissions can retry after settings resync.

Open Browser follows the current China/International selection, including before the first successful probe. Auto follows the last successful probe's `en`/`cn` region, with the historical China landing page until a successful result exists. The wire region keeps `en`/`cn`; the setting's `intl`/`auto` vocabulary never replaces it.

Region memory lives in the runtime's `providerRuntimeState` and resets with a new runtime. Only responses with quota windows update it; unavailable responses leave the last successful region intact. Changing a key can still resolve the other region through Auto's fallback.

## Verification

`node --test tests/shared/minimaxLimits.test.js tests/electron/limitAccountPanels.test.js tests/electron/limitProviderWiring.test.js tests/electron/credentialCommands.test.js` covers region parsing, remembered-region precedence, transport and endpoint fallbacks, runtime quota retention, setup links, saved-settings/env precedence, and credential submission. Live quota verification requires an account in the selected region.
