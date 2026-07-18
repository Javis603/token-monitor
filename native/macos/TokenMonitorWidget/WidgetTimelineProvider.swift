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
        let period = currentPeriod()
        let page = effectivePage(for: configuration, family: context.family)
        let snapshot = currentSnapshot(period: period)
        let selectedActivityDate = selectedActivityDate(in: snapshot, family: context.family, referenceDate: now)
        return TokenMonitorEntry(date: now, snapshot: snapshot, page: page, period: period, selectedActivityDate: selectedActivityDate)
    }

    func timeline(for configuration: TokenMonitorWidgetConfigurationIntent, in context: Context) async -> Timeline<TokenMonitorEntry> {
        let now = Date()
        let period = currentPeriod()
        let page = effectivePage(for: configuration, family: context.family)
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

extension WidgetSnapshot {
    private static func placeholderActivityDays(count: Int) -> [WidgetActivityDay] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let end = calendar.date(from: DateComponents(year: 2026, month: 7, day: 17))!
        return (0..<count).map { index in
            let date = calendar.date(byAdding: .day, value: index - count + 1, to: end)!
            let parts = calendar.dateComponents([.year, .month, .day], from: date)
            let key = String(format: "%04d-%02d-%02d", parts.year!, parts.month!, parts.day!)
            return WidgetActivityDay(date: key, intensity: index % 5)
        }
    }

    static let placeholder = WidgetSnapshot(
        schemaVersion: 5,
        generatedAt: Date(),
        overview: WidgetOverview(currentPeriod: "today", totalTokens: 27_800_000, costUsd: 14.86, primaryTool: "codex", updatedAt: Date()),
        quota: [
            WidgetQuotaProvider(provider: "codex", status: "ok", updatedAt: Date(), windows: [WidgetLimitWindow(kind: "weekly", usedPercent: 98, remainingPercent: 2, resetsAt: Date().addingTimeInterval(6 * 86_400), windowMinutes: 10_080)]),
            WidgetQuotaProvider(provider: "mimo", status: "ok", updatedAt: Date(), windows: [], balance: WidgetQuotaBalance(amount: 3.62, currency: "CNY")),
            WidgetQuotaProvider(provider: "deepseek", status: "ok", updatedAt: Date(), windows: [], balance: WidgetQuotaBalance(amount: 9.33, currency: "CNY")),
            WidgetQuotaProvider(provider: "antigravity", status: "notConfigured", updatedAt: Date(), windows: [])
        ],
        models: [WidgetModel(displayName: "GPT-5.6", totalTokens: 20_900_000, costUsd: 10, sharePercent: 75), WidgetModel(displayName: "MiMo", totalTokens: 2_900_000, costUsd: 2, sharePercent: 11)],
        activity: WidgetActivity(currentPeriod: "month", activeDays: 18, days: placeholderActivityDays(count: 28)),
        trend: WidgetTrend(startDate: "07/04", endDate: "07/17", peakTokens: 4_200_000, currentTokens: 2_800_000, points: (1...14).map { WidgetTrendPoint(date: "\($0)", totalTokens: $0 * 200_000, costUsd: 0) }),
        periods: [
            .day: WidgetPeriodSnapshot(
                overview: WidgetOverview(currentPeriod: "today", totalTokens: 27_800_000, costUsd: 14.86, primaryTool: "codex", updatedAt: Date()),
                models: [WidgetModel(displayName: "GPT-5.6", totalTokens: 20_900_000, costUsd: 10, sharePercent: 75), WidgetModel(displayName: "MiMo", totalTokens: 2_900_000, costUsd: 2, sharePercent: 11)],
                activity: WidgetActivity(currentPeriod: "today", activeDays: 1, days: placeholderActivityDays(count: 7)),
                trend: WidgetTrend(startDate: "07/04", endDate: "07/17", peakTokens: 4_200_000, currentTokens: 2_800_000, points: (1...14).map { WidgetTrendPoint(date: "\($0)", totalTokens: $0 * 200_000, costUsd: 0) })
            ),
            .month: WidgetPeriodSnapshot(
                overview: WidgetOverview(currentPeriod: "month", totalTokens: 61_200_000, costUsd: 237.42, primaryTool: "codex", updatedAt: Date()),
                models: [WidgetModel(displayName: "GPT-5.6", totalTokens: 44_000_000, costUsd: 120, sharePercent: 72), WidgetModel(displayName: "MiMo", totalTokens: 7_000_000, costUsd: 10, sharePercent: 11)],
                activity: WidgetActivity(currentPeriod: "month", activeDays: 18, days: placeholderActivityDays(count: 28)),
                trend: WidgetTrend(startDate: "07/04", endDate: "07/17", peakTokens: 9_200_000, currentTokens: 4_800_000, points: (1...14).map { WidgetTrendPoint(date: "\($0)", totalTokens: $0 * 340_000, costUsd: 0) })
            ),
            .total: WidgetPeriodSnapshot(
                overview: WidgetOverview(currentPeriod: "allTime", totalTokens: 180_000_000, costUsd: 620.15, primaryTool: "codex", updatedAt: Date()),
                models: [WidgetModel(displayName: "GPT-5.6", totalTokens: 120_000_000, costUsd: 220, sharePercent: 67), WidgetModel(displayName: "MiMo", totalTokens: 30_000_000, costUsd: 38, sharePercent: 17)],
                activity: WidgetActivity(currentPeriod: "allTime", activeDays: 144, days: placeholderActivityDays(count: 180)),
                trend: WidgetTrend(startDate: "01/01", endDate: "07/17", peakTokens: 18_200_000, currentTokens: 12_800_000, points: (1...14).map { WidgetTrendPoint(date: "\($0)", totalTokens: $0 * 900_000, costUsd: 0) })
            )
        ],
        presentation: .default,
        status: WidgetStatus(isStale: false, dataAgeSeconds: 30, providerConfigured: true, providerNeedsLogin: false, noData: false)
    )
}
