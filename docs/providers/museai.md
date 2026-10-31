---
summary: "Meta Muse weekly allowance through the muse.ai browser session, separate from Muse Code."
ids: [museai]
read_when:
  - Changing Muse (Meta) credentials, subscription parsing or transport
---

# Muse (Meta)

## Identity and ids

`museai` is Meta's personal agent at muse.ai. The existing `muse` id belongs to Muse Code and keeps its CLI login and local transcripts. Muse (Meta) is limits-only: weekly percentage, reset time, plan, and additional balance when provided. It supplies no local token history.

The subscription response has no stable account identity. Rows remain device-scoped in aggregation and renderer account selection, as with Muse Code. The same account on two devices therefore appears twice; with multiple anonymous rows a subscription binding remains unresolved rather than selecting an arbitrary device.

## Data sources

The signed-in website's `fetchSubscriptionAction` returns a React Flight subscription row. The provider discovers the current Next.js action id from the page's settings-loader chunks, caches it only after successful parsing in runtime memory, and discovers it again once after a stale-action 404. Discovery is capped at 96 page chunks and 32 settings chunks, eight concurrent requests, under one 20-second deadline. Static chunks receive no cookies. A changed loader or response format reports unavailable data.

Weekly allowance is percentage-only. A website-provided “tokens left” label is display text, never a measured token count or a denominator inferred from a rounded percentage. Additional balances are micro-dollars converted to USD, separate from the weekly window; no top-up percentage is added to the wire record.

## Credentials and transport

Paste the Cookie request header from a signed-in muse.ai request in Settings, or use `TOKEN_MONITOR_MUSEAI_COOKIE` / `MUSEAI_COOKIE`. Credentials stay in the main-process credential store; no browser cookie import or native Muse Keychain access occurs. Expired sessions require a fresh cookie.

Electron injects the existing Node exchange transport used by MiMo for this provider. Chromium controls `Sec-Fetch-*` headers and does not support the manual redirects needed here. The Node transport preserves the required same-origin headers, inspects authentication redirects without forwarding cookies, and honors the app proxy, environment proxy and resolved system/PAC routes. Other providers retain their existing transport.

The reference implementation and response fixtures are from [CodexBar's MuseAI provider](https://github.com/steipete/CodexBar/tree/897bff31731bb4b21b105f6e8bf4c32a8a8bf095/Sources/CodexBarCore/Resources/Plugins/museai.js). Adapted portions retain its [MIT notice](../../src/shared/providers/museai/LICENSE).

## Verification

Run `node --test tests/shared/museaiLimits.test.js tests/electron/museaiIntegration.test.js` and `npm run verify`. Fixtures cover Free/Power/Maximum shapes, action discovery and rotation, authentication, bounded discovery and cancellation. Fixtures and native transport checks do not establish live account acceptance; a signed-in Muse account is still required to verify the website end to end.
