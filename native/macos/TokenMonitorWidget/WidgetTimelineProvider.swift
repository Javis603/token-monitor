import WidgetKit

struct TokenMonitorEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
    let page: WidgetPage
    let period: WidgetPeriod
    let selectedActivityDate: String?
    let selectedQuotaProviderIDs: [String]
}

private enum WidgetTimelineFactory {
    static func placeholder(page: WidgetPage, period: WidgetPeriod = .day) -> TokenMonitorEntry {
        TokenMonitorEntry(date: Date(), snapshot: WidgetSnapshot.placeholder.selecting(period), page: page, period: period, selectedActivityDate: nil, selectedQuotaProviderIDs: [])
    }

    static func entry(
        page: WidgetPage,
        period: WidgetPeriod,
        context: TimelineProviderContext,
        demandFileName: String? = nil,
        selectedQuotaProviderIDs: [String] = []
    ) -> TokenMonitorEntry {
        let now = Date()
        if let demandFileName {
            WidgetDemandMarker.noteRequested(
                fileName: demandFileName,
                appGroup: TokenMonitorWidgetConfiguration.appGroup,
                now: now
            )
        }
        let loaded = WidgetSnapshot.load(appGroup: TokenMonitorWidgetConfiguration.appGroup)?.selecting(period)
        let snapshot = WidgetPeriodPolicy.previewAwareSnapshot(loaded: loaded, period: period, isPreview: context.isPreview)
        let selectedActivityDate = WidgetActivitySelection.resolvedDate(
            days: snapshot?.activity.days ?? [],
            family: WidgetFamilyScope(widgetFamily: context.family),
            referenceDate: now,
            store: WidgetPresentationStateStore.shared
        )
        return TokenMonitorEntry(date: now, snapshot: snapshot, page: page, period: period, selectedActivityDate: selectedActivityDate, selectedQuotaProviderIDs: selectedQuotaProviderIDs)
    }

    static func timeline(page: WidgetPage, period: WidgetPeriod, context: TimelineProviderContext, selectedQuotaProviderIDs: [String] = []) -> Timeline<TokenMonitorEntry> {
        let entry = entry(page: page, period: period, context: context, demandFileName: WidgetDemandMarker.fileName, selectedQuotaProviderIDs: selectedQuotaProviderIDs)
        return Timeline(entries: [entry], policy: .after(entry.date.addingTimeInterval(15 * 60)))
    }

    static func quotaIDs(_ identifiers: String?...) -> [String] {
        var seen = Set<String>()
        var uniqueIdentifiers: [String] = []
        for identifier in identifiers {
            guard let identifier, seen.insert(identifier).inserted else { continue }
            uniqueIdentifiers.append(identifier)
        }
        return uniqueIdentifiers
    }
}

struct SummaryWidgetTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TokenMonitorEntry { WidgetTimelineFactory.placeholder(page: .overview) }
    func snapshot(for configuration: UsageSummaryWidgetIntent, in context: Context) async -> TokenMonitorEntry {
        WidgetTimelineFactory.entry(page: .overview, period: configuration.period, context: context, demandFileName: context.isPreview ? nil : WidgetDemandMarker.provisionalFileName)
    }
    func timeline(for configuration: UsageSummaryWidgetIntent, in context: Context) async -> Timeline<TokenMonitorEntry> {
        WidgetTimelineFactory.timeline(page: .overview, period: configuration.period, context: context)
    }
}

struct BreakdownWidgetTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TokenMonitorEntry { WidgetTimelineFactory.placeholder(page: .tools) }
    func snapshot(for configuration: BreakdownWidgetIntent, in context: Context) async -> TokenMonitorEntry {
        WidgetTimelineFactory.entry(page: configuration.breakdown.page, period: configuration.period, context: context, demandFileName: context.isPreview ? nil : WidgetDemandMarker.provisionalFileName)
    }
    func timeline(for configuration: BreakdownWidgetIntent, in context: Context) async -> Timeline<TokenMonitorEntry> {
        WidgetTimelineFactory.timeline(page: configuration.breakdown.page, period: configuration.period, context: context)
    }
}

struct TrendWidgetTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TokenMonitorEntry { WidgetTimelineFactory.placeholder(page: .trend) }
    func snapshot(for configuration: TrendWidgetIntent, in context: Context) async -> TokenMonitorEntry {
        WidgetTimelineFactory.entry(page: .trend, period: configuration.period, context: context, demandFileName: context.isPreview ? nil : WidgetDemandMarker.provisionalFileName)
    }
    func timeline(for configuration: TrendWidgetIntent, in context: Context) async -> Timeline<TokenMonitorEntry> {
        WidgetTimelineFactory.timeline(page: .trend, period: configuration.period, context: context)
    }
}

struct DashboardWidgetTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TokenMonitorEntry { WidgetTimelineFactory.placeholder(page: .models) }
    func snapshot(for configuration: DashboardWidgetIntent, in context: Context) async -> TokenMonitorEntry {
        WidgetTimelineFactory.entry(page: configuration.breakdown.page, period: configuration.period, context: context, demandFileName: context.isPreview ? nil : WidgetDemandMarker.provisionalFileName, selectedQuotaProviderIDs: WidgetTimelineFactory.quotaIDs(configuration.primaryQuota?.id, configuration.secondaryQuota?.id))
    }
    func timeline(for configuration: DashboardWidgetIntent, in context: Context) async -> Timeline<TokenMonitorEntry> {
        WidgetTimelineFactory.timeline(page: configuration.breakdown.page, period: configuration.period, context: context, selectedQuotaProviderIDs: WidgetTimelineFactory.quotaIDs(configuration.primaryQuota?.id, configuration.secondaryQuota?.id))
    }
}

struct QuotaWidgetTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TokenMonitorEntry { WidgetTimelineFactory.placeholder(page: .quota) }
    func snapshot(for configuration: QuotaWidgetIntent, in context: Context) async -> TokenMonitorEntry {
        WidgetTimelineFactory.entry(page: .quota, period: .day, context: context, demandFileName: context.isPreview ? nil : WidgetDemandMarker.provisionalFileName, selectedQuotaProviderIDs: WidgetTimelineFactory.quotaIDs(configuration.primaryQuota?.id, configuration.secondaryQuota?.id))
    }
    func timeline(for configuration: QuotaWidgetIntent, in context: Context) async -> Timeline<TokenMonitorEntry> {
        WidgetTimelineFactory.timeline(page: .quota, period: .day, context: context, selectedQuotaProviderIDs: WidgetTimelineFactory.quotaIDs(configuration.primaryQuota?.id, configuration.secondaryQuota?.id))
    }
}

struct FixedWidgetTimelineProvider: TimelineProvider {
    let page: WidgetPage
    func placeholder(in context: Context) -> TokenMonitorEntry { WidgetTimelineFactory.placeholder(page: page) }
    func getSnapshot(in context: Context, completion: @escaping (TokenMonitorEntry) -> Void) {
        completion(WidgetTimelineFactory.entry(page: page, period: .day, context: context, demandFileName: context.isPreview ? nil : WidgetDemandMarker.provisionalFileName))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<TokenMonitorEntry>) -> Void) {
        completion(WidgetTimelineFactory.timeline(page: page, period: .day, context: context))
    }
}

// Compatibility seam for tests and preview targets that still instantiate the
// original provider. It is not exposed by the Widget bundle anymore.
struct TokenMonitorTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> TokenMonitorEntry { WidgetTimelineFactory.placeholder(page: .overview) }
    func snapshot(for configuration: TokenMonitorWidgetConfigurationIntent, in context: Context) async -> TokenMonitorEntry {
        let period = WidgetPeriodPolicy.effectivePeriod(for: configuration.page, selectedPeriod: configuration.period)
        return WidgetTimelineFactory.entry(page: configuration.page, period: period, context: context, demandFileName: context.isPreview ? nil : WidgetDemandMarker.provisionalFileName)
    }
    func timeline(for configuration: TokenMonitorWidgetConfigurationIntent, in context: Context) async -> Timeline<TokenMonitorEntry> {
        let period = WidgetPeriodPolicy.effectivePeriod(for: configuration.page, selectedPeriod: configuration.period)
        return WidgetTimelineFactory.timeline(page: configuration.page, period: period, context: context)
    }
    func selectedActivityDate(in snapshot: WidgetSnapshot?, family: WidgetFamily, referenceDate: Date = Date(), store: WidgetPresentationStateStoring = WidgetPresentationStateStore.shared) -> String? {
        WidgetActivitySelection.resolvedDate(days: snapshot?.activity.days ?? [], family: WidgetFamilyScope(widgetFamily: family), referenceDate: referenceDate, store: store)
    }
}
