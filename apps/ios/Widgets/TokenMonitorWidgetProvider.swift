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
        var entries = [entry]
        // Render the stale state even if WidgetKit defers the next reload.
        if let staleDate = entry.freshnessDate, staleDate > entry.date {
            entries.append(TokenMonitorWidgetEntry(
                date: staleDate,
                snapshot: entry.snapshot,
                preferences: entry.preferences,
                configuration: configuration
            ))
        }
        return Timeline(entries: entries, policy: .after(entry.date.addingTimeInterval(15 * 60)))
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
