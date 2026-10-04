# iOS interface

Token Monitor on iOS is a native, read-only companion to an authenticated Hub. The primary tasks are checking current usage, finding quota pressure, inspecting trends and session summaries, and configuring system surfaces.

Use system typography, semantic foreground colors, the system grouped canvas, and one blue action accent. Content surfaces stay opaque and readable; Liquid Glass belongs to native tab/navigation chrome and actions. Avoid layers of custom material underneath system glass. Large metrics use monospaced digits, not monospaced prose. Support light/dark appearance, Dynamic Type, VoiceOver, Reduce Motion and Reduce Transparency.

Overview leads with the selected period, token/cost summary, a Sessions destination and quota pressure, followed by trends, breakdowns and devices. Limits groups each account's real windows and keeps money balances distinct from percentages. Insights exposes trend/heatmap/breakdown readings without duplicating desktop controls. Sessions searches bounded authenticated summaries; it never retrieves transcripts. Settings keeps connection, display and system-surface configuration separate and provides truthful remote/local Activity status.

Widgets adapt to WidgetKit's full-color and accented/clear rendering. Small sizes show one meaningful reading; larger sizes add attribution and quota windows. Accessory layouts are purpose-built. ActivityKit controls the Lock Screen material; compact and expanded Dynamic Island use separate layouts. Stale content is marked explicitly. Updating transport timestamps alone must not imply the usage source was refreshed.

All previews use illustrative data. Current data and zero are different from missing readings. Offline views retain the current Hub's last received data; destination changes clear the previous Hub's data. Widget and Activity updates remain subject to platform budgets.
