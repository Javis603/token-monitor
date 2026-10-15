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
- `Features`: Overview, Limits, Sessions, Insights, and Settings
- `Widgets`: configurable Home Screen widgets, Lock Screen accessory, Live Activity, and Dynamic Island

The app reads:

- `GET /api/stats`
- `GET /api/stats/stream`
- `GET /api/history`
- `POST /api/live-activities/register` and `DELETE /api/live-activities/{activityID}` for ActivityKit push-token registration

The shared secret is sent as a bearer token and is stored in the iOS Keychain. The Hub URL is stored in user defaults.

When the Hub has APNs ActivityKit credentials configured, the app registers its Live Activity push token with the Hub. The Hub then sends remote updates while the app is suspended; without those credentials, local updates and the iOS background-refresh fallback still work.

The display language can follow the system or be set to English, Traditional Chinese, Simplified Chinese, Japanese, or Korean. Costs can be shown in USD, TWD, HKD, or CNY using the same display rates as the Desktop app; USD uses the compact `$` symbol.

## Quota presentation

The Limits screen preserves the existing Liquid Glass card for each provider group, and Overview keeps its shared quota card. Account dividers remain inside the cards. Quota readings use compact system text with monospaced digits; paired headers adapt together when space is limited, keeping the meters aligned. Fixed quota labels (Session, Weekly, Monthly, Reset), percentages, countdown units and freshness follow the desktop English presentation; navigation, settings and explanatory details remain localized. It preserves the desktop window relationships: primary Session/Weekly lanes sit side by side, lone lanes and Monthly/additional pools use a full row, Cursor windows each use a full row, and Antigravity groups pair their own rolling and weekly windows. Accessibility text sizes stack paired lanes. Supplied windows with unknown usage remain visible rather than disappearing.

Authenticated `resetCredits` data adds the available reset count and sorted expiry countdowns beneath each account. An anchored popover shows exact dates and Claude grant coverage/restrictions without opening a full-page sheet. Missing or zero available counts do not create a reset row. Quota countdowns retain days/hours or hours/minutes and refresh every minute.

WorkBuddy groups can optionally show a combined quota in Customize AI Limits. The option defaults off and applies to app cards only. A total requires every account in the group to have a fresh, healthy, finite CREDITS allowance with matching pool, region and reset metadata; missing, failed or unlimited readings suppress it. Individual accounts stay visible. Encrypted local-app sessions retain their specific status instead of asking the user to sign in again. Notion AI, Goose and CatPaw use the desktop artwork and labels.

## System surfaces and freshness

The Home Screen gallery offers Liquid Glass, Transparent and Solid widgets with the same content options; Solid also supports Lock Screen accessories. Full-color wallpaper transparency and host blur currently use an isolated private WidgetKit descriptor bridge because the public removable container background does not provide those effects in full-color mode. The bridge is guarded and falls back to WidgetKit's opaque host if its runtime contract is unavailable, but it is not a supported App Store API. Small widgets pair one dominant reading with a daily-usage bar series, a compact second quota window, or the activity grid; medium adds top-tool columns or paired quota columns; large adds stat rows and tool/model or multi-provider detail. Settings → Widgets previews the real widget view at each size from the latest Hub snapshot. Medium widgets offer paired or stacked quota windows and chart-first or stats-and-chart activity layouts. The activity calendar uses compact squares with Desktop's maximum-relative intensity bands and month labels below the grid; the large family shows two chronological half-year strips. Shared defaults also control reset time and text contrast. Widgets using App Default follow those preferences, while explicit per-widget overrides retain precedence. Choose the background kind and size on the Home Screen. Live Activity source, account, window and display choices are available inline below the appearance gallery. Lock Screen accessories show compact usage or quota readings. Live Activities provide separate Lock Screen and Dynamic Island layouts, and mark expired content as stale. In Settings → Live Activity, each side of the compact island, the presentation shown beside other activities, and the expanded and Lock Screen layouts each pair an appearance with a data source — like the desktop menu bar: an automatic AI tool (lowest remaining or most recently used) or a named one, an account, a quota window, remaining or used, a period, and all tools or only the recent one.

Widgets read the latest App Group snapshot. The app publishes while connected, and iOS may run a background refresh; WidgetKit and Background Tasks choose their own update budgets. A widget timeline is not a continuous Hub connection. Remote Live Activity updates require a Hub/Worker built from this iOS branch, APNs configuration and a successful push-token registration. The v0.71.0 mainline Hub has no `/api/live-activities/register` route; connecting to that build retains foreground updates but cannot enable remote pushes. A simulator build or local Activity update does not verify remote delivery.

The icon-only native tab bar provides Overview, Limits, Sessions, Insights and Settings with Desktop vector artwork and localized accessibility names. Overview adds up to three recent interactive sessions, prioritizing running sessions, and its Sections editor can reorder or hide that block. Sessions deep links open the root tab. Settings keeps Hub first, followed by compact Live Activity and Widgets rows showing their purpose and status. Full previews and controls live in their customizer pages; Widget counts reflect WidgetKit’s current configurations, with unavailable results kept distinct from zero. A dismissible Overview invitation appears when both surfaces are unused.

The Sessions screen shows bounded today/month summaries from authenticated Hub stats, with tool, model and project search. It does not fetch conversation transcripts. Canonical titles appear only if the sending device and Hub have enabled title sync. Omitted session detail is disclosed while aggregate totals remain complete.

Untitled session rows put the tool and model on the same first line, matching the desktop fallback. The optional live speed beside the Overview brand mark uses differences in each device's timed output and timed duration between Hub frames. It is separate from the period's average speed: without consecutive timed samples it shows a dash, and an idle reading dims before clearing.

## Local validation

```sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
  -project apps/ios/TokenMonitor.xcodeproj -scheme TokenMonitor \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath /tmp/token-monitor-ios-build CODE_SIGNING_ALLOWED=NO test
npm run verify
```

Debug builds accept `--sample-data` and `--sample-tab=overview|limits|sessions|insights|settings` for reproducible UI inspection without Hub credentials. `--sample-empty-sessions` gives a connected Hub with empty today/month session lists. `--sample-live-activity` also renders a local demonstration Activity. These options are compiled out of release builds.


## Refresh validation (2026-10-05)

The refreshed app and Widget extension build successfully with Xcode 27 on the iPhone 18 Pro simulator. The full native test target passes 33 tests in 11 suites, including Hub destination races, SSE ordering, trailing surface updates, Activity registration cleanup, source freshness, missing-vs-zero readings, sessions and credits balances. Root `npm run verify` passes 5,917 tests with two skips. Hub and Worker generated sources were refreshed and match their build identities.

Simulator screenshots and runtime accessibility snapshots are saved under `/private/tmp/ios-refresh-artifacts`; these use illustrative data. The final rebuild also compiles complete Traditional Chinese, Simplified Chinese, Japanese and Korean translations for the redesigned surfaces. Hardware APNs delivery and system-selected widget clear/tinted appearances still need a configured device check.

### Shared model presentation

The app reads authenticated `/api/sync/settings/modelAliases` and refreshes its cached map when `syncSettingsRevisions.modelAliases` changes. It follows desktop manual aliases and `off` / `duplicates` / `prefix` grouping for model and session lists. Grouping folds the Hub's model tokens and model costs together without changing source records or repricing them. Custom pricing stays with the collecting device and Tokscale; iOS displays the resulting Hub USD costs. Session cache estimates use the optional `promptCache` observation, expire locally, and never infer an estimate from cache-hit percentages. Source-tagged background reviews and Cursor Grok Bot activity form separate expandable groups ordered with interactive sessions by latest activity. Grok Bot identity survives model display aliases and mixed-model periods. Sessions and expanded groups scroll continuously without manual paging.
