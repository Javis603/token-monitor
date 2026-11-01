---
summary: "Muse Code transcript accounting and Muse CLI/web allowance within one provider, with separate source and credential boundaries."
ids: [muse]
read_when:
  - Changing Muse usage accounting, source roots or subscription quota collection
  - Changing Meta Muse model recognition
---

# Muse / Muse Code

## Identity and ids

`muse` remains the tracked Muse Code client id and the single Muse limits provider id. The tracked client is labelled Muse Code; the limits provider is labelled Muse and includes both Muse Code CLI and the muse.ai personal agent. Its CLI and web allowances are separate rows under the same provider, not combined quota windows. `meta` is the model vendor mark; it does not represent a separate account or collection source. Muse Spark, Wonder, Glimmer, Image and Voice names resolve to Meta in both the Electron charts and native macOS widget.

## Data sources

Token usage and cost come from the pinned Tokscale scanner, reading `$XDG_DATA_HOME/muse/sessions/` (default `~/.local/share/muse/sessions/`). Muse's input includes cached tokens and output includes reasoning; Tokscale splits those buckets, and Token Monitor adds disjoint reasoning back to output. Never add cached or reasoning tokens twice. The executable fixture in `scripts/verify-vendored-tokscale.js` and the usage/history tests guard this accounting.

Subscription allowance comes separately from Muse Code 1.4.13+ via `muse usage --json`; it does not start a model turn. Schema v1 reports an `allowance` with `tier`, `window`, `weekly`, `asOfMs` and `source`; periods carry `usedPercent` and `resetsAtMs`. A `windowDurationMins` field is accepted when present but the verified 1.4.13 response omits it. Percentages are used percentages and reset timestamps are milliseconds, not seconds. Session and weekly pools remain independent. The provider stamps the row with `asOfMs` capped at the local clock, so a stale or clock-skewed observation cannot pose as a fresh one.

The web lane reads the signed-in muse.ai settings dialog's `fetchSubscriptionAction` React Flight response. Weekly usage is percentage-only, with a reset time and plan; website-provided “tokens left” is display text, not a measured token count or an inferred denominator. Additional balances are micro-dollars converted to USD and kept separate from the weekly window. It supplies no local token history.

## Credentials and transport

Muse Code owns its CLI authentication. Token Monitor invokes the native launcher from PATH, falling back to `~/.local/bin` and standard Unix install locations. It never copies CLI credentials into settings or the renderer. Sign in using `muse login`; API-key billing is separate from subscription allowance.

The probe uses `execFile` without a shell, closes stdin, bounds output to 256 KiB, times out after 15 seconds and honors collector cancellation. Timeout, output overflow and cancellation terminate the read-only process with `SIGKILL`, so a CLI that handles `SIGTERM` cannot keep polling alive. It runs outside the project directory and sets `MUSE_NO_AUTO_UPDATE=1`, preventing routine quota polling from updating the launcher or binary. Quota refresh follows the shared limits scheduler; token-file changes do not trigger it.

For the web lane, paste the Cookie request header from a signed-in muse.ai request in Settings, or use `TOKEN_MONITOR_MUSE_WEB_COOKIE` / `MUSE_WEB_COOKIE`. Credentials stay in main's credential store; there is no automatic browser cookie import or native Muse Keychain access. Save-time probes validate only the submitted web cookie, so a working CLI login cannot vouch for an expired web session.

The web probe discovers the current Next.js action id from settings-loader chunks and caches it only after successful parsing, in runtime memory. A stale-action 404 triggers one rediscovery. Discovery is capped at 96 page chunks and 32 settings chunks, eight concurrent requests, under one 20-second deadline. Static chunks receive no cookies. Website loader/schema changes report unavailable data.

Electron injects the existing proxy-aware Node exchange transport used by MiMo: Chromium controls `Sec-Fetch-*` headers and does not support the manual redirects needed here. The injected transport preserves the required same-origin headers and inspects authentication redirects without forwarding cookies, while honoring app, environment and system/PAC proxy routes. Other providers retain their existing transport.

The web implementation and response fixtures are adapted from [CodexBar's MuseAI provider](https://github.com/steipete/CodexBar/blob/897bff31731bb4b21b105f6e8bf4c32a8a8bf095/Sources/CodexBarCore/Resources/Plugins/museai.js), retaining its [MIT notice](../../src/shared/providers/muse/LICENSE).

## Invariants and known gaps

`allowance: null` (including `server_sent_no_usage`, `api_key` and `no_allowance`) is unavailable data, never a full allowance or zero usage. Malformed JSON, unsupported schemas and invalid percentages likewise produce no windows. Only explicit CLI sign-in failures are unauthorized; an absent CLI is not configured.

Neither quota source exposes a stable account identifier. The provider leaves `accountKey` empty rather than inventing one from a plan or credential. Muse Code retains its existing device-scoped CLI observations. The web product follows the shared cross-device freshness, status and timestamp ranking to display one winning observation, independently of CLI. Its `sourceDeviceId` records provenance, not account identity. Different web accounts on synced devices cannot be distinguished and compete for that displayed web reading.

Renderer dedupe mirrors this policy: one anonymous web reading across devices, while CLI observations stay scoped to their device. Local account-picker readings retain the caller's existing priority over aggregate copies. Subscription bindings cannot durably identify a particular product or CLI device while account identities are empty; ambiguous account bindings require rebinding. Refresh scopes remain provider-wide, including reset-boundary and adaptive probes. Runtime rows remain keyed by source, so a refresh cannot create a label-keyed duplicate. Cookie changes invalidate only this device's web reading in the runtime and UI caches, preserving CLI and remote readings. A successful refresh of one product does not hide the other's stale last-good allowance.

## Verification

Run `node --test tests/shared/museLimits.test.js tests/shared/museWebLimits.test.js tests/electron/museIntegration.test.js tests/shared/usage.test.js tests/shared/history.test.js tests/electron/dashboardCharts.test.js tests/electron/widgetVendorParity.test.js` and `npm run verify`.

A live Muse Code 1.4.13 probe on a signed-in subscription returned a populated allowance (`tier`, session/weekly `usedPercent` with millisecond `resetsAtMs`, plus `asOfMs`/`source`), and both windows matched the text form of `muse usage`. An earlier probe on the same install returned `allowance: null` with `server_sent_no_usage` before first use in a new window; both shapes are covered by the tests, while boundary and malformed cases remain constructed from that verified schema. Windows launcher execution and native widget appearance still need manual acceptance on their respective platforms. See the [official Muse changelog](https://dev.meta.ai/docs/muse-code/changelog) for the command's introduction.

Web fixtures cover Free/Power/Maximum responses, action discovery/rotation, expired cookies, cancellation and bounded requests. Integration tests keep simultaneous CLI/web quotas separate through runtime, synchronization and renderer dedupe, and retire a removed lane. Native macOS Electron checks cover the sandboxed EN/zh-TW form and local HTTP transport fixtures. Live signed-in muse.ai acceptance and Windows/Linux native UI acceptance remain unverified.
