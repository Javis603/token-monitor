import WidgetKit

struct TokenMonitorWidgetProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TokenMonitorWidgetEntry {
        .placeholder
    }

    func snapshot(
        for configuration: TokenMonitorWidgetIntent,
        in context: Context
    ) async -> TokenMonitorWidgetEntry {
        entry(for: configuration)
    }

    func timeline(
        for configuration: TokenMonitorWidgetIntent,
        in context: Context
    ) async -> Timeline<TokenMonitorWidgetEntry> {
        let entry = entry(for: configuration)
        return Timeline(
            entries: [entry],
            policy: .after(.now.addingTimeInterval(15 * 60))
        )
    }

    private func entry(
        for configuration: TokenMonitorWidgetIntent
    ) -> TokenMonitorWidgetEntry {
        let payload = (try? SharedSnapshotStore().load())
            ?? TokenMonitorSharedPayload()
        return TokenMonitorWidgetEntry(
            date: .now,
            snapshot: payload.snapshot,
            preferences: payload.preferences,
            configuration: configuration
        )
    }
}
