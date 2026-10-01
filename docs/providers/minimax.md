---
summary: MiniMax Token Plan region selection and endpoint fallbacks
ids: [minimax]
read_when:
  - Changing MiniMax region selection, credentials, or quota endpoint fallbacks
---

## Source precedence

An explicit `minimaxApiRegion` choice wins over the legacy probe option `minimaxApiHost`, then `TOKEN_MONITOR_MINIMAX_API_REGION`, `MINIMAX_API_REGION`, and `MINIMAX_API_HOST`. Region and hostname aliases are exact matches. The default is `auto`: international first, then China only after an authentication rejection. Within each region, the Token Plan endpoint falls back to the legacy Coding Plan endpoint on the existing migration/error signals. Pinning a region removes only the cross-region fallback.

## Credentials and transport

The API key stays in the main-process credential store. Region changes retain the key, clear the old quota, and immediately refresh only MiniMax through the normal settings invalidation path. Calls use the injected transport and fixed MiniMax API URLs.

## Invariants and known gaps

An unchosen region stays empty in stored settings. Renderer projection and runtime config resolve the environment at use time; displaying Auto or saving a key must not freeze an implicit default. An explicit Auto selection is stored as `auto` and overrides the environment. The form's region saves independently (`submitWithCredential: false`); key submission waits for that write and omits the region from its credential draft.

Open Browser follows the current China/International selection, including before the first successful probe. Auto follows the last successful probe's `en`/`cn` region, with the historical China landing page until a successful result exists. The wire region keeps `en`/`cn`; the setting's `intl`/`auto` vocabulary never replaces it.

## Verification

`node --test tests/shared/minimaxLimits.test.js tests/electron/limitAccountPanels.test.js tests/electron/limitProviderWiring.test.js tests/electron/credentialCommands.test.js` covers region parsing, endpoint fallback, setup links, saved-settings/env precedence, and credential submission. Live quota verification requires an account in the selected region.
