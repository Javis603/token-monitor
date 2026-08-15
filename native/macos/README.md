# Native macOS Widget

This directory contains the WidgetKit extension embedded by the Electron macOS build.

## Configuration

The committed defaults are non-personal placeholders. Ordinary macOS packaging does not include the Widget:

- `npm run pack`
- `npm run dist:mac`
- `npm run dist:mac:x64`
- the Release workflow

They leave `TOKEN_MONITOR_WIDGET_ENABLED` unset/disabled and therefore do not require Widget artifacts or Widget identifiers. Only the explicit `pack:mac:widget` and `dist:mac:widget*` entries enable the Widget.

For a local unsigned or ad-hoc preview, use the example identifiers and `TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING=1`. This mode does not validate production App Group authorization and must not be used as evidence that a formal distribution build is provisioned.

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

`npm run build:mac-widget` follows the selected target architecture (`arm64` or `x64` → `x86_64`) and stages an unsigned local Widget preview. Use `npm run pack:mac:widget` for a local ad-hoc-signed preview, or `dist:mac:widget` / `dist:mac:widget:x64` with production identifiers, profiles where required, and signing credentials. The packaging verifier checks the complete `.app` bundle, exact architectures, identifiers, URL scheme, entitlements, and embedded profiles before release handoff. The release signer signs the extension before the containing Electron app.

WidgetKit schedules timeline refreshes; the 15-minute policy is a request, not a real-time guarantee. The extension keeps displaying the last valid snapshot while the main app is closed and shows explicit missing/stale states.

The extension uses `AppIntentConfiguration` for the initial Overview, Quota, Models, Activity, or Trend selection. The left page pill is also an App Intent button: it cycles pages without opening the host app and stores page state per widget family (`small`, `medium`, `large`) in App Group `UserDefaults`. Multiple widgets of the same family share that family page state. DAY / MONTH / TOTAL are App Intent buttons backed by separate App Group presentation state, shared across all Token Monitor widgets without changing the host app settings. Only Overview and Models consume that selected period; Quota, Activity, and Trend use the DAY snapshot and omit the period control. Every non-future date cell inside the Medium and Large activity coverage uses an App Intent button, including dates missing from `activity.days[]`; missing dates display `0 tokens` without opening the host app. Small remains non-interactive. Medium reserves a dedicated detail slot, while Large replaces its date-range caption in place so selecting a cell does not change the activity layout density. Snapshot schema v6 adds stable provider/model instance identifiers and source freshness metadata; the decoder retains schema v1-v5 compatibility.

The current interaction limitation is intentional: the period selected for Overview and Models is global across all Widget sizes, and widgets of the same size share the same page state. Activity day selection remains per family and is not cleared by period actions. Keep these boundaries when changing the snapshot or App Group presentation keys.

Small, Medium, and Large use a fixed header/content/footer scaffold. Header owns the brand and the optional Overview/Models period control, content owns only the selected page body, and footer owns the page cycling button plus the open-page link. The header keeps the same height when Quota, Activity, or Trend omits the period control. The scaffold uses a single `VStack` with fixed header/footer heights and a flexible content slot, relying on WidgetKit system content margins as its only outer margin source. Quota/model rows size themselves from the real content height, and activity uses a seven-row Sunday-start calendar grid with adaptive week and cell counts. Keep header/footer outside individual page views so the brand, page button, and arrow do not move while users cycle pages or periods.
