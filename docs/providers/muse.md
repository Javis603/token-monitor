---
summary: "Muse Code transcript accounting and CLI subscription allowance, with separate data and credential boundaries."
ids: [muse]
read_when:
  - Changing Muse usage accounting, source roots or subscription quota collection
  - Changing Meta Muse model recognition
---

# Muse Code

## Identity and ids

`muse` is both the tracked Muse Code client and its limits provider; the display name is Muse Code. The separate muse.ai personal agent allowance uses the independent [`museai` provider](museai.md). `meta` is the model vendor mark; it does not represent a separate account or collection source. Muse Spark, Wonder, Glimmer, Image and Voice names resolve to Meta in both the Electron charts and native macOS widget.

## Data sources

Token usage and cost come from the pinned Tokscale scanner, reading `$XDG_DATA_HOME/muse/sessions/` (default `~/.local/share/muse/sessions/`). Muse's input includes cached tokens and output includes reasoning; Tokscale splits those buckets, and Token Monitor adds disjoint reasoning back to output. Never add cached or reasoning tokens twice. The executable fixture in `scripts/verify-vendored-tokscale.js` and the usage/history tests guard this accounting.

Subscription allowance comes separately from Muse Code 1.4.13+ via `muse usage --json`; it does not start a model turn. Schema v1 reports an `allowance` with `tier`, `window`, `weekly`, `asOfMs` and `source`; periods carry `usedPercent` and `resetsAtMs`. A `windowDurationMins` field is accepted when present but the verified 1.4.13 response omits it. Percentages are used percentages and reset timestamps are milliseconds, not seconds. Session and weekly pools remain independent. The provider stamps the row with `asOfMs` capped at the local clock, so a stale or clock-skewed observation cannot pose as a fresh one.

## Credentials and transport

Muse owns authentication. Token Monitor invokes the native launcher from PATH, falling back to `~/.local/bin` and standard Unix install locations. It never copies Muse credentials into settings or the renderer. Sign in using `muse login`; API-key billing is separate from subscription allowance.

The probe uses `execFile` without a shell, closes stdin, bounds output to 256 KiB, times out after 15 seconds and honors collector cancellation. Timeout, output overflow and cancellation terminate the read-only process with `SIGKILL`, so a CLI that handles `SIGTERM` cannot keep polling alive. It runs outside the project directory and sets `MUSE_NO_AUTO_UPDATE=1`, preventing routine quota polling from updating the launcher or binary. Quota refresh follows the shared limits scheduler; token-file changes do not trigger it.

## Invariants and known gaps

`allowance: null` (including `server_sent_no_usage`, `api_key` and `no_allowance`) is unavailable data, never a full allowance or zero usage. Malformed JSON, unsupported schemas and invalid percentages likewise produce no windows. Only explicit CLI sign-in failures are unauthorized; an absent CLI is not configured.

The quota response exposes no stable account identifier. The provider leaves `accountKey` empty rather than inventing one from a plan or credential, and aggregation keeps Muse rows scoped to their source device, so different Muse accounts on synced devices stay separate rows instead of silently coalescing. The same account observed from two devices likewise appears once per device; this is not a multi-account integration.

The renderer's account dedupe follows the same device scoping for anonymous Muse rows: `dedupeAccounts`/`sameAccount` in `src/electron/renderer/accountIdentity.js` keep one row per trimmed, case-sensitive `sourceDeviceId`, and local rows are stamped with their device's id on copies so a device's local and aggregate rows collapse into one. Rows with no device id form a single unknown-device observation and never merge with a known device row. Because subscription bindings persist only `profileName`/`accountKey`/`accountEmail` — all empty for Muse — a subscription cannot be durably bound to one particular anonymous Muse device: with two devices present the binding stays unresolved (a rebind prompt) rather than silently matching either row, while a single device still matches unambiguously. No identity is derived from the tier, plan name or credential to work around this.

## Verification

Run `node --test tests/shared/museLimits.test.js tests/shared/usage.test.js tests/shared/history.test.js tests/electron/dashboardCharts.test.js tests/electron/widgetVendorParity.test.js` and `npm run verify`.

A live Muse Code 1.4.13 probe on a signed-in subscription returned a populated allowance (`tier`, session/weekly `usedPercent` with millisecond `resetsAtMs`, plus `asOfMs`/`source`), and both windows matched the text form of `muse usage`. An earlier probe on the same install returned `allowance: null` with `server_sent_no_usage` before first use in a new window; both shapes are covered by the tests, while boundary and malformed cases remain constructed from that verified schema. Windows launcher execution and native widget appearance still need manual acceptance on their respective platforms. See the [official Muse changelog](https://dev.meta.ai/docs/muse-code/changelog) for the command's introduction.
