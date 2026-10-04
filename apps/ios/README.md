# Token Monitor for iOS

The iOS app is a read-only SwiftUI client for an existing Token Monitor Hub. It does not run collectors or store provider credentials.

## Requirements

- Xcode 26 or later
- iOS 26 or later
- Swift 6

## Architecture

- `Core/Models`: defensive decoders for the Hub wire contract
- `Core/Networking`: authenticated REST and Server-Sent Events client
- `Core/Security`: Keychain-backed Hub secret storage
- `Core/State`: app-level connection and data state
- `DesignSystem`: semantic tokens and reusable native surfaces
- `Features`: Overview, Limits, Insights, Sessions, and Settings
- `Widgets`: configurable Home Screen widgets, Lock Screen accessory, Live Activity, and Dynamic Island

The app reads:

- `GET /api/stats`
- `GET /api/stats/stream`
- `GET /api/history`
- `POST /api/live-activities/register` and `DELETE /api/live-activities/{activityID}` for ActivityKit push-token registration

The shared secret is sent as a bearer token and is stored in the iOS Keychain. The Hub URL is stored in user defaults.

When the Hub has APNs ActivityKit credentials configured, the app registers its Live Activity push token with the Hub. The Hub then sends remote updates while the app is suspended; without those credentials, local updates and the iOS background-refresh fallback still work.

The display language can follow the system or be set to English, Traditional Chinese, Simplified Chinese, Japanese, or Korean. Costs can be shown in USD, TWD, HKD, or CNY using the same display rates as the Desktop app; USD uses the compact `$` symbol.

## System surfaces and freshness

Home Screen widgets use WidgetKit's system container and accented rendering, so the same layout adapts to full color, tinted and clear appearances. Small widgets prioritize one metric; larger widgets add breakdowns or quota windows. Lock Screen accessories show compact usage or quota readings. Live Activities provide separate Lock Screen and Dynamic Island layouts, and mark expired content as stale.

Widgets read the latest App Group snapshot. The app publishes while connected, and iOS may run a background refresh; WidgetKit and Background Tasks choose their own update budgets. A widget timeline is not a continuous Hub connection. Remote Live Activity updates require APNs configuration on the Hub and a successful push-token registration. A simulator build or local Activity update does not verify remote delivery.

The Sessions screen shows bounded today/month summaries from authenticated Hub stats, with tool, model and project search. It does not fetch conversation transcripts. Canonical titles appear only if the sending device and Hub have enabled title sync. Omitted session detail is disclosed while aggregate totals remain complete.

## Local validation

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project apps/ios/TokenMonitor.xcodeproj -scheme TokenMonitor \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath /tmp/token-monitor-ios-build CODE_SIGNING_ALLOWED=NO test
npm run verify
```

Debug builds accept `--sample-data` and `--sample-tab=overview|limits|insights|settings` for reproducible UI inspection without Hub credentials. `--sample-live-activity` also renders a local demonstration Activity. These options are compiled out of release builds.


## Refresh validation (2026-10-05)

The refreshed app and Widget extension build successfully with Xcode 27 on the iPhone 18 Pro simulator. The full native test target passes 33 tests in 11 suites, including Hub destination races, SSE ordering, trailing surface updates, Activity registration cleanup, source freshness, missing-vs-zero readings, sessions and credits balances. Root `npm run verify` passes 5,917 tests with two skips. Hub and Worker generated sources were refreshed and match their build identities.

Simulator screenshots and runtime accessibility snapshots are saved under `/private/tmp/ios-refresh-artifacts`; these use illustrative data. The final rebuild also compiles complete Traditional Chinese, Simplified Chinese, Japanese and Korean translations for the redesigned surfaces. Hardware APNs delivery and system-selected widget clear/tinted appearances still need a configured device check.
