import WidgetKit

struct TokenMonitorEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    let page: WidgetPage
    let period: WidgetPeriod
    let selectedActivityDate: String?
}

struct TokenMonitorTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TokenMonitorEntry {
        TokenMonitorEntry(date: Date(), snapshot: .placeholder.selecting(.day), page: .overview, period: .day, selectedActivityDate: nil)
    }

    func snapshot(for configuration: TokenMonitorWidgetConfigurationIntent, in context: Context) async -> TokenMonitorEntry {
        let now = Date()
        if !context.isPreview {
            WidgetDemandMarker.noteRequested(
                fileName: WidgetDemandMarker.provisionalFileName,
                appGroup: TokenMonitorWidgetConfiguration.appGroup,
                now: now
            )
        }
        let page = effectivePage(for: configuration, family: context.family)
        let period = WidgetPeriodPolicy.effectivePeriod(for: page, selectedPeriod: currentPeriod())
        let snapshot = WidgetPeriodPolicy.previewAwareSnapshot(
            loaded: currentSnapshot(period: period),
            period: period,
            isPreview: context.isPreview
        )
        let selectedActivityDate = selectedActivityDate(in: snapshot, family: context.family, referenceDate: now)
        return TokenMonitorEntry(date: now, snapshot: snapshot, page: page, period: period, selectedActivityDate: selectedActivityDate)
    }

    func timeline(for configuration: TokenMonitorWidgetConfigurationIntent, in context: Context) async -> Timeline<TokenMonitorEntry> {
        let now = Date()
        WidgetDemandMarker.noteRequested(appGroup: TokenMonitorWidgetConfiguration.appGroup, now: now)
        let page = effectivePage(for: configuration, family: context.family)
        let period = WidgetPeriodPolicy.effectivePeriod(for: page, selectedPeriod: currentPeriod())
        let snapshot = currentSnapshot(period: period)
        let selectedActivityDate = selectedActivityDate(in: snapshot, family: context.family, referenceDate: now)
        let entry = TokenMonitorEntry(date: now, snapshot: snapshot, page: page, period: period, selectedActivityDate: selectedActivityDate)
        return Timeline(entries: [entry], policy: .after(now.addingTimeInterval(15 * 60)))
    }

    private func currentPeriod() -> WidgetPeriod {
        WidgetPresentationStateStore.shared.selectedPeriod()
    }

    private func currentSnapshot(period: WidgetPeriod) -> WidgetSnapshot? {
        WidgetSnapshot.load(appGroup: TokenMonitorWidgetConfiguration.appGroup)?.selecting(period)
    }

    private func effectivePage(for configuration: TokenMonitorWidgetConfigurationIntent, family: WidgetFamily) -> WidgetPage {
        guard let scope = WidgetFamilyScope(widgetFamily: family) else {
            return configuration.page
        }
        return WidgetPresentationStateStore.shared.effectivePage(configuredPage: configuration.page, for: scope)
    }

    func selectedActivityDate(
        in snapshot: WidgetSnapshot?,
        family: WidgetFamily,
        referenceDate: Date = Date(),
        store: WidgetPresentationStateStoring = WidgetPresentationStateStore.shared
    ) -> String? {
        WidgetActivitySelection.resolvedDate(
            days: snapshot?.activity.days ?? [],
            family: WidgetFamilyScope(widgetFamily: family),
            referenceDate: referenceDate,
            store: store
        )
    }
}
