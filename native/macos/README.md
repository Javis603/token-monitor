# Native macOS Widget

This directory contains the WidgetKit extension embedded by the Electron macOS build.

## Configuration

The committed defaults are non-personal placeholders. Ordinary macOS packaging does not include the Widget:

- `npm run pack`
- `npm run dist:mac`
- `npm run dist:mac:x64`
- the Release workflow

They leave `TOKEN_MONITOR_WIDGET_ENABLED` unset/disabled and therefore do not require Widget artifacts or Widget identifiers. Only the explicit `pack:mac:widget` and `dist:mac:widget*` entries enable the Widget.

For a local unsigned or ad-hoc preview, use the example identifiers and `TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING=1`. This mode does not validate production App Group authorization and must not be used as evidence that a formal distribution build is provisioned. A Team-prefixed App Group plus its matching `DEVELOPMENT_TEAM` instead selects an Apple Development identity, because an ad-hoc host and extension cannot reliably access that App Group. Set `TOKEN_MONITOR_MAC_DEVELOPMENT_IDENTITY` only when more than one Apple Development identity is installed.

For a formal Widget distribution, configure all of the following without committing their values:

- `TOKEN_MONITOR_APP_GROUP` — shared App Group used by the Electron app and extension.
- `TOKEN_MONITOR_WIDGET_BUNDLE_ID` — extension bundle identifier.
- `TOKEN_MONITOR_WIDGET_DISTRIBUTION=1` — enables production validation.
- `TOKEN_MONITOR_MAC_DISTRIBUTION_CHANNEL=developer-id` — the only formal distribution channel currently supported.
- `TOKEN_MONITOR_APP_PROVISIONING_PROFILE` — app provisioning profile when the App Group uses the `group.*` form.
- `TOKEN_MONITOR_WIDGET_PROVISIONING_PROFILE` — extension provisioning profile for the same App Group.
- `DEVELOPMENT_TEAM` — Apple Developer Team ID used by Xcode when signing is enabled.
- `TOKEN_MONITOR_WIDGET_URL_SCHEME` — page-specific Widget deep-link scheme.
- `TOKEN_MONITOR_WIDGET_KIND` — stable WidgetKit kind shared by the extension and reload helper.

The Widget bundle identifier must be inside the configured Electron app identifier namespace. App Groups must use either the `group.<name>` form or the `<10-character-DEVELOPMENT_TEAM>.<name>` form; the latter requires an explicit matching `DEVELOPMENT_TEAM`. A `group.*` App Group requires both provisioning profiles, and those profiles must be non-development Developer ID profiles (`get-task-allow=false`, `ProvisionsAllDevices=true`, and no `ProvisionedDevices`). The build fails before signing when required production values, identifiers, channel, or profiles are invalid.

Do not commit personal values, certificates, provisioning profiles, or private keys. A usable App Group must exist in the selected Apple Developer account and be enabled by both provisioning profiles.

## Build and test

```bash
TOKEN_MONITOR_WIDGET_ARCH=arm64 npm run build:mac-widget
TOKEN_MONITOR_WIDGET_ARCH=x64 npm run build:mac-widget
xcodebuild -project native/macos/TokenMonitorWidget.xcodeproj -scheme TokenMonitorWidget -destination 'platform=macOS' test CODE_SIGNING_ALLOWED=NO
```

`npm run build:mac-widget` follows the selected target architecture (`arm64` or `x64` → `x86_64`) and stages an unsigned local Widget preview. Use `npm run pack:mac:widget` once to create the Electron host. During ordinary SwiftUI iteration, deploy into that existing app without rebuilding Electron or vendored tools:

```bash
npm run dev:mac-widget -- --app '/absolute/path/to/Token Monitor.app'
```

The fast path keeps persistent Xcode DerivedData, rebuilds only the arm64 Widget extension, preserves the configured App Group, signs with the matching Apple Development identity, re-registers the host, and relaunches it. The first run may re-sign the full Electron bundle when converting an old ad-hoc app; later runs sign only the changed extension and outer container. Use `dist:mac:widget` / `dist:mac:widget:x64` with production identifiers, profiles where required, and signing credentials for release artifacts. The packaging verifier checks the complete `.app` bundle, exact architectures, identifiers, URL scheme, entitlements, and embedded profiles before release handoff. The release signer signs the extension before the containing Electron app.

WidgetKit schedules timeline refreshes; the 15-minute policy is a request, not a real-time guarantee. The extension keeps displaying the last valid snapshot while the main app is closed and shows explicit missing/stale states.

The extension uses `AppIntentConfiguration` to give every Widget instance a focused Overview, Quota, Tools, Models, Activity, or Trend view. Overview, Tools, and Models also take a fixed Today / This month / All time period from the Widget configuration; Quota, Activity, and Trend use the Today snapshot. There is no in-Widget page or period navigation. Clicking the Widget opens its corresponding page in Token Monitor. Every non-future date cell inside the Medium and Large activity coverage remains an App Intent button, including dates missing from `activity.days[]`; missing dates display `0 tokens` without opening the host app. Small remains non-interactive. Snapshot schema v8 adds privacy-safe masked quota account labels while retaining schema v1-v7 decoding compatibility.

Activity day selection remains per family and does not alter a Widget instance's configured view or period. Keep that boundary when changing the snapshot or App Group presentation keys.

Each family has its own composition. Small is a glanceable period total with cost and a smooth trend line. Medium keeps the period total at left and uses the remaining space for one configurable Activity, Quota, Tools, Models, or Trend module. Large is a compact dashboard combining the period total, trend context, quotas, a configurable Tools or Models breakdown, and the activity heatmap. The views use WidgetKit system content margins and Token Monitor's dark blue-black visual system in every appearance.
