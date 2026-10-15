import ActivityKit
import SwiftUI
import WidgetKit

// Rendering lives in Shared/ActivityViews.swift so the Settings customizer and
// the running activity draw the same pixels. The pushed state carries data
// only; the layout, currency and language come from the app group, so the
// device decides presentation whichever Hub sent the update.
struct TokenMonitorActivityWidget: Widget {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: TokenMonitorActivityAttributes.self) { context in
            ActivityLockScreenView(context: activityContext(context))
                // A clear tint exposes the iOS 26 host glass. Accessibility uses the host default.
                .activityBackgroundTint(reduceTransparency ? nil : .clear)
                .widgetURL(URL(string: "tokenmonitor://overview"))
        } dynamicIsland: { context in
            let activity = activityContext(context)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ActivityExpandedLeading(context: activity)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ActivityExpandedTrailing(context: activity)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ActivityExpandedBottom(context: activity)
                }
            } compactLeading: {
                ActivityCompactItemView(context: activity, slot: activity.layout.compactLeading)
            } compactTrailing: {
                ActivityCompactItemView(context: activity, slot: activity.layout.compactTrailing)
            } minimal: {
                ActivityMinimalView(context: activity)
            }
            .keylineTint(ActivityPalette.quotaTint(activity.reading(activity.layout.compactLeading.source)?.quota.providerID))
            .widgetURL(URL(string: "tokenmonitor://overview"))
        }
    }

    private func activityContext(
        _ context: ActivityViewContext<TokenMonitorActivityAttributes>
    ) -> ActivityContext {
        let preferences = (try? SharedSnapshotStore().load().preferences) ?? .default
        return ActivityContext(
            state: context.state,
            preferences: preferences,
            isStale: context.isStale
                || context.state.sourceStale == true
                || context.state.quotas.first?.stale == true
        )
    }
}
