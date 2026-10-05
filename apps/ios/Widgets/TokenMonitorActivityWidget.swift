import ActivityKit
import SwiftUI
import WidgetKit

// Rendering lives in Shared/ActivityViews.swift so the Settings customizer and
// the running activity draw the same pixels.
struct TokenMonitorActivityWidget: Widget {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TokenMonitorActivityAttributes.self) { context in
            ActivityLockScreenView(state: context.state, isStale: isStale(context))
                // A clear tint exposes the iOS 26 host glass. Accessibility uses the host default.
                .activityBackgroundTint(reduceTransparency ? nil : .clear)
                .widgetURL(URL(string: "tokenmonitor://overview"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    ActivityExpandedView(state: context.state, isStale: isStale(context))
                }
            } compactLeading: {
                ActivityCompactLeadingView(state: context.state, isStale: isStale(context))
            } compactTrailing: {
                ActivityCompactTrailingView(state: context.state, isStale: isStale(context))
                    .frame(maxWidth: 72)
            } minimal: {
                ActivityMinimalView(state: context.state, isStale: isStale(context))
            }
            .widgetURL(URL(string: "tokenmonitor://overview"))
        }
    }

    private func isStale(
        _ context: ActivityViewContext<TokenMonitorActivityAttributes>
    ) -> Bool {
        context.isStale
            || context.state.sourceStale == true
            || context.state.quota?.stale == true
    }
}
