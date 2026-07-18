# Native macOS Widget

This directory contains the WidgetKit extension embedded by the Electron macOS build.

## Configuration

The committed defaults are non-personal placeholders. Set these environment variables for a real development or distribution identity:

- `TOKEN_MONITOR_APP_GROUP` — shared App Group used by the Electron app and extension.
- `TOKEN_MONITOR_WIDGET_BUNDLE_ID` — extension bundle identifier.
- `DEVELOPMENT_TEAM` — Apple Developer Team ID used by Xcode when signing is enabled.
- `TOKEN_MONITOR_WIDGET_URL_SCHEME` — page-specific Widget deep-link scheme.
- `TOKEN_MONITOR_WIDGET_KIND` — stable WidgetKit kind shared by the extension and reload helper.

Do not commit personal values, certificates, provisioning profiles, or private keys. A usable App Group must exist in the selected Apple Developer account and be enabled by both provisioning profiles.

## Build and test

```bash
npm run build:mac-widget
xcodebuild -project native/macos/TokenMonitorWidget.xcodeproj -scheme TokenMonitorWidget -destination 'platform=macOS' test CODE_SIGNING_ALLOWED=NO
```

`npm run dist:mac` runs the Widget build first and embeds `TokenMonitorWidget.appex` under `Contents/PlugIns`. The release signer must sign the extension with `TokenMonitorWidget.entitlements` before signing the containing Electron app.

WidgetKit schedules timeline refreshes; the 15-minute policy is a request, not a real-time guarantee. The extension keeps displaying the last valid snapshot while the main app is closed and shows explicit missing/stale states.

The extension uses `AppIntentConfiguration` for the initial Overview, Quota, Models, Activity, or Trend selection. The left page pill is also an App Intent button: it cycles pages without opening the host app and stores page state per widget family (`small`, `medium`, `large`) in App Group `UserDefaults`. Multiple widgets of the same family share that family page state. DAY / MONTH / TOTAL are App Intent buttons backed by separate App Group presentation state, shared across all Token Monitor widgets without changing the host app settings. Every non-future date cell inside the Medium and Large activity coverage uses an App Intent button, including dates missing from `activity.days[]`; missing dates display `0 tokens` without opening the host app. Small remains non-interactive. Medium reserves a dedicated detail slot, while Large replaces its date-range caption in place so selecting a cell does not change the activity layout density. Snapshot schema v5 adds only `activity.days[].totalTokens`, and the decoder retains schema v1-v4 compatibility.

Small, Medium, and Large use a fixed header/content/footer scaffold. Header owns the brand and period controls, content owns only the selected page body, and footer owns the page cycling button plus the open-page link. The scaffold uses a single `VStack` with fixed header/footer heights and a flexible content slot, relying on WidgetKit system content margins as its only outer margin source. Quota/model rows size themselves from the real content height, and activity uses a seven-row Sunday-start calendar grid with adaptive week and cell counts. Keep header/footer outside individual page views so the brand, period controls, page button, and arrow do not move while users cycle pages or periods.
