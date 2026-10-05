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
- `Features`: Overview, Limits, Insights, and Settings
- `Widgets`: configurable Home Screen widgets, Lock Screen accessory, Live Activity, and Dynamic Island

The app reads:

- `GET /api/stats`
- `GET /api/stats/stream`
- `GET /api/history`
- `POST /api/live-activities/register` and `DELETE /api/live-activities/{activityID}` for ActivityKit push-token registration

The shared secret is sent as a bearer token and is stored in the iOS Keychain. The Hub URL is stored in user defaults.

When the Hub has APNs ActivityKit credentials configured, the app registers its Live Activity push token with the Hub. The Hub then sends remote updates while the app is suspended; without those credentials, local updates and the iOS background-refresh fallback still work.

The display language can follow the system or be set to English, Traditional Chinese, Simplified Chinese, Japanese, or Korean. Costs can be shown in USD, TWD, HKD, or CNY using the same display rates as the Desktop app; USD uses the compact `$` symbol.
