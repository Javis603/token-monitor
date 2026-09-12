import AppIntents
import Foundation
import WidgetKit

enum WidgetPage: String, AppEnum, CaseIterable {
    case overview
    case quota
    case tools
    case models
    case activity
    case trend

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Display Page")
    static let caseDisplayRepresentations: [WidgetPage: DisplayRepresentation] = [
        .overview: DisplayRepresentation(title: "Overview", image: .init(systemName: "house")),
        .quota: DisplayRepresentation(title: "Quota", image: .init(systemName: "gauge.with.dots.needle.50percent")),
        .tools: DisplayRepresentation(title: "Tools", image: .init(systemName: "hammer")),
        .models: DisplayRepresentation(title: "Models", image: .init(systemName: "cpu")),
        .activity: DisplayRepresentation(title: "Activity", image: .init(systemName: "square.grid.3x3")),
        .trend: DisplayRepresentation(title: "Trend", image: .init(systemName: "chart.xyaxis.line"))
    ]

    var title: String {
        switch self {
        case .overview: WidgetL10n.text("Overview")
        case .quota: WidgetL10n.text("Quota")
        case .tools: WidgetL10n.text("Tools")
        case .models: WidgetL10n.text("Models")
        case .activity: WidgetL10n.text("Activity")
        case .trend: WidgetL10n.text("Trend")
        }
    }

    var systemImage: String {
        switch self {
        case .overview: "house"
        case .quota: "gauge.with.dots.needle.50percent"
        case .tools: "hammer"
        case .models: "cpu"
        case .activity: "square.grid.3x3"
        case .trend: "chart.xyaxis.line"
        }
    }

}

struct TokenMonitorWidgetConfigurationIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Token Monitor Widget"
    static let description = IntentDescription("Choose one focused view and period for this widget.")

    @Parameter(title: "Display Page", default: .overview)
    var page: WidgetPage

    @Parameter(title: "Period", default: .day)
    var period: WidgetPeriod
}

enum WidgetBreakdown: String, AppEnum, CaseIterable {
    case tools
    case models

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Breakdown")
    static let caseDisplayRepresentations: [WidgetBreakdown: DisplayRepresentation] = [
        .tools: DisplayRepresentation(title: "Tools"),
        .models: DisplayRepresentation(title: "Models")
    ]

    var page: WidgetPage {
        switch self {
        case .tools: .tools
        case .models: .models
        }
    }
}

struct UsageSummaryWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Usage Summary"
    static let description = IntentDescription("Choose the usage period shown by this widget.")

    @Parameter(title: "Period", default: .day)
    var period: WidgetPeriod
}

struct BreakdownWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Usage Breakdown"
    static let description = IntentDescription("Choose a tool or model breakdown and its period.")

    @Parameter(title: "Breakdown", default: .tools)
    var breakdown: WidgetBreakdown

    @Parameter(title: "Period", default: .day)
    var period: WidgetPeriod
}

struct TrendWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Usage Trend"
    static let description = IntentDescription("Choose the usage period summarized by this trend.")

    @Parameter(title: "Period", default: .day)
    var period: WidgetPeriod
}

struct DashboardWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Dashboard"
    static let description = IntentDescription("Choose the dashboard period and breakdown.")

    @Parameter(title: "Period", default: .day)
    var period: WidgetPeriod

    @Parameter(title: "Breakdown", default: .models)
    var breakdown: WidgetBreakdown

    @Parameter(title: "Quota 1")
    var primaryQuota: WidgetQuotaSelection?

    @Parameter(title: "Quota 2")
    var secondaryQuota: WidgetSecondaryQuotaSelection?
}

struct QuotaWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Quota"
    static let description = IntentDescription("Choose up to two quota accounts to keep visible.")

    @Parameter(title: "Quota 1")
    var primaryQuota: WidgetQuotaSelection?

    @Parameter(title: "Quota 2")
    var secondaryQuota: WidgetSecondaryQuotaSelection?
}

enum WidgetQuotaSelectionID {
    static let currentCodexAccount = "codex-current-account"
}

struct WidgetQuotaSelection: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota Account")
    static let defaultQuery = WidgetQuotaSelectionQuery()

    let id: String
    let name: String
    let provider: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct WidgetQuotaSelectionQuery: EntityQuery {
    func entities(for identifiers: [WidgetQuotaSelection.ID]) async throws -> [WidgetQuotaSelection] {
        let identifierSet = Set(identifiers)
        return Self.availableSelections.filter { identifierSet.contains($0.id) }
    }

    func suggestedEntities() async throws -> [WidgetQuotaSelection] {
        Self.availableSelections
    }

    func defaultResult() async -> WidgetQuotaSelection? {
        Self.availableSelections.first { $0.id != WidgetQuotaSelectionID.currentCodexAccount }
    }

    private static var availableSelections: [WidgetQuotaSelection] {
        WidgetQuotaSelectionCatalog.availableSelections.map { selection in
            WidgetQuotaSelection(
                id: selection.id,
                name: selection.name,
                provider: selection.provider
            )
        }
    }
}

// Quota 2 deliberately uses a distinct AppEntity query. WidgetKit asks each
// parameter for its own default, and using the same query for both fields makes
// both resolve to the first account. The secondary query starts at item two.
struct WidgetSecondaryQuotaSelection: AppEntity {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota Account")
    static let defaultQuery = WidgetSecondaryQuotaSelectionQuery()

    let id: String
    let name: String
    let provider: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct WidgetSecondaryQuotaSelectionQuery: EntityQuery {
    func entities(for identifiers: [WidgetSecondaryQuotaSelection.ID]) async throws -> [WidgetSecondaryQuotaSelection] {
        let identifierSet = Set(identifiers)
        return Self.availableSelections.filter { identifierSet.contains($0.id) }
    }

    func suggestedEntities() async throws -> [WidgetSecondaryQuotaSelection] {
        Self.availableSelections
    }

    func defaultResult() async -> WidgetSecondaryQuotaSelection? {
        Self.availableSelections
            .filter { $0.id != WidgetQuotaSelectionID.currentCodexAccount }
            .dropFirst()
            .first
    }

    private static var availableSelections: [WidgetSecondaryQuotaSelection] {
        WidgetQuotaSelectionCatalog.availableSelections.map { selection in
            WidgetSecondaryQuotaSelection(
                id: selection.id,
                name: selection.name,
                provider: selection.provider
            )
        }
    }
}

private struct WidgetQuotaSelectionValue {
    let id: String
    let name: String
    let provider: String
}

private enum WidgetQuotaSelectionCatalog {
    static var availableSelections: [WidgetQuotaSelectionValue] {
        let appGroup = Bundle.main.object(forInfoDictionaryKey: "TokenMonitorAppGroup") as? String ?? ""
        guard let snapshot = WidgetSnapshot.load(appGroup: appGroup) else { return [] }

        let providerCounts = Dictionary(grouping: snapshot.quota, by: \.provider).mapValues(\.count)
        var providerOrdinals: [String: Int] = [:]
        let concreteSelections = snapshot.quota.map { provider in
            let baseName = provider.displayName ?? WidgetFormat.provider(provider.provider)
            providerOrdinals[provider.provider, default: 0] += 1
            let ordinal = providerOrdinals[provider.provider, default: 1]
            let selectionName: String
            if providerCounts[provider.provider, default: 0] > 1 {
                if let accountLabel = provider.accountLabel, !accountLabel.isEmpty {
                    selectionName = "\(baseName) · \(accountLabel)"
                } else {
                    selectionName = "\(baseName) \(ordinal)"
                }
            } else {
                selectionName = baseName
            }
            return WidgetQuotaSelectionValue(
                id: provider.instanceId,
                name: selectionName,
                provider: provider.provider
            )
        }
        let codexProviders = snapshot.quota.filter { $0.provider.caseInsensitiveCompare("codex") == .orderedSame }
        guard codexProviders.count > 1, codexProviders.contains(where: \.isCurrentAccount) else {
            return concreteSelections
        }
        guard let insertionIndex = concreteSelections.firstIndex(where: {
            $0.provider.caseInsensitiveCompare("codex") == .orderedSame
        }) else { return concreteSelections }

        var selections = concreteSelections
        selections.insert(
            WidgetQuotaSelectionValue(
                id: WidgetQuotaSelectionID.currentCodexAccount,
                name: "Codex · \(String(localized: "Current Account"))",
                provider: "codex"
            ),
            at: insertionIndex
        )
        return selections
    }
}

enum WidgetPeriod: String, Codable, AppEnum, CaseIterable {
    case day
    case month
    case total

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Period")
    static let caseDisplayRepresentations: [WidgetPeriod: DisplayRepresentation] = [
        .day: DisplayRepresentation(title: "Day"),
        .month: DisplayRepresentation(title: "Month"),
        .total: DisplayRepresentation(title: "Total")
    ]

    var title: String {
        switch self {
        case .day: "DAY"
        case .month: "MONTH"
        case .total: "TOTAL"
        }
    }

    var accessibilityName: String {
        switch self {
        case .day: WidgetL10n.text("Today usage")
        case .month: WidgetL10n.text("This month usage")
        case .total: WidgetL10n.text("All-time usage")
        }
    }

    var displayTitle: String {
        switch self {
        case .day: "TODAY"
        case .month: "MONTH"
        case .total: "TOTAL"
        }
    }

    var next: WidgetPeriod {
        switch self {
        case .day: .month
        case .month: .total
        case .total: .day
        }
    }

    var snapshotKey: String { rawValue }

    static func normalized(_ value: String?) -> WidgetPeriod {
        WidgetPeriod(rawValue: String(value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)) ?? .day
    }
}

enum WidgetPeriodPolicy {
    static func isSelectable(on page: WidgetPage) -> Bool {
        page == .overview || page == .tools || page == .models
    }

    static func effectivePeriod(for page: WidgetPage, selectedPeriod: WidgetPeriod) -> WidgetPeriod {
        isSelectable(on: page) ? selectedPeriod : .day
    }

    // The gallery renders an entry for every family at once, before the app has
    // necessarily written a snapshot and before the user has committed to
    // anything. A nil snapshot there draws the redacted placeholder skeleton,
    // which reads as a broken widget rather than one that is still loading, so a
    // preview falls back to representative sample data. A placed widget keeps
    // nil: inventing numbers on a real instance would be a lie.
    static func previewAwareSnapshot(
        loaded: WidgetSnapshot?,
        period: WidgetPeriod,
        isPreview: Bool
    ) -> WidgetSnapshot? {
        if let loaded { return loaded }
        return isPreview ? WidgetSnapshot.placeholder.selecting(period) : nil
    }
}

enum WidgetFamilyScope: String, Codable, AppEnum, CaseIterable {
    case small
    case medium
    case large

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Widget Size")
    static let caseDisplayRepresentations: [WidgetFamilyScope: DisplayRepresentation] = [
        .small: DisplayRepresentation(title: "Small"),
        .medium: DisplayRepresentation(title: "Medium"),
        .large: DisplayRepresentation(title: "Large")
    ]

    init?(widgetFamily: WidgetFamily) {
        switch widgetFamily {
        case .systemSmall:
            self = .small
        case .systemMedium:
            self = .medium
        case .systemLarge:
            self = .large
        default:
            return nil
        }
    }
}

protocol WidgetPresentationStateStoring {
    func selectedPeriod() -> WidgetPeriod
    func setSelectedPeriod(_ period: WidgetPeriod)
    func selectedPage(for family: WidgetFamilyScope) -> WidgetPage?
    func setSelectedPage(_ page: WidgetPage, for family: WidgetFamilyScope)
    func clearSelectedPage(for family: WidgetFamilyScope)
    func clearSelectedPages()
    func lastConfiguredPage(for family: WidgetFamilyScope) -> WidgetPage?
    func setLastConfiguredPage(_ page: WidgetPage, for family: WidgetFamilyScope)
    func clearLastConfiguredPage(for family: WidgetFamilyScope)
    func effectivePage(configuredPage: WidgetPage, for family: WidgetFamilyScope) -> WidgetPage
    func selectedActivityDay(for family: WidgetFamilyScope) -> String?
    func setSelectedActivityDay(_ date: String, for family: WidgetFamilyScope)
    func clearSelectedActivityDay(for family: WidgetFamilyScope)
    func clearSelectedActivityDays()
}

final class WidgetPresentationStateStore: WidgetPresentationStateStoring {
    static let selectedPeriodKey = "selectedPeriod"
    static let selectedPageKeyPrefix = "widget.presentation.page"
    static let lastConfiguredPageKeyPrefix = "widget.presentation.config-page"
    static let selectedActivityDayKeyPrefix = "widget.presentation.activity-day"
    static let shared = WidgetPresentationStateStore()

    private let defaults: UserDefaults?

    init(defaults: UserDefaults? = nil) {
        if let defaults {
            self.defaults = defaults
        } else if let appGroup = Bundle.main.object(forInfoDictionaryKey: "TokenMonitorAppGroup") as? String,
                  !appGroup.isEmpty {
            self.defaults = UserDefaults(suiteName: appGroup)
        } else {
            self.defaults = nil
        }
    }

    func selectedPeriod() -> WidgetPeriod {
        WidgetPeriod.normalized(defaults?.string(forKey: Self.selectedPeriodKey))
    }

    func setSelectedPeriod(_ period: WidgetPeriod) {
        defaults?.set(period.rawValue, forKey: Self.selectedPeriodKey)
    }

    func selectedPage(for family: WidgetFamilyScope) -> WidgetPage? {
        guard let defaults else { return nil }
        let key = pageKey(for: family)
        guard let raw = defaults.string(forKey: key) else { return nil }
        guard let page = WidgetPage(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            defaults.removeObject(forKey: key)
            return nil
        }
        return page
    }

    func setSelectedPage(_ page: WidgetPage, for family: WidgetFamilyScope) {
        defaults?.set(page.rawValue, forKey: pageKey(for: family))
    }

    func clearSelectedPage(for family: WidgetFamilyScope) {
        defaults?.removeObject(forKey: pageKey(for: family))
    }

    func clearSelectedPages() {
        for family in WidgetFamilyScope.allCases {
            clearSelectedPage(for: family)
        }
    }

    func lastConfiguredPage(for family: WidgetFamilyScope) -> WidgetPage? {
        guard let defaults else { return nil }
        let key = lastConfiguredPageKey(for: family)
        guard let raw = defaults.string(forKey: key) else { return nil }
        guard let page = WidgetPage(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            defaults.removeObject(forKey: key)
            return nil
        }
        return page
    }

    func setLastConfiguredPage(_ page: WidgetPage, for family: WidgetFamilyScope) {
        defaults?.set(page.rawValue, forKey: lastConfiguredPageKey(for: family))
    }

    func clearLastConfiguredPage(for family: WidgetFamilyScope) {
        defaults?.removeObject(forKey: lastConfiguredPageKey(for: family))
    }

    func effectivePage(configuredPage: WidgetPage, for family: WidgetFamilyScope) -> WidgetPage {
        let interactivePage = selectedPage(for: family)
        guard let lastConfiguredPage = lastConfiguredPage(for: family) else {
            setLastConfiguredPage(configuredPage, for: family)
            return interactivePage ?? configuredPage
        }

        if configuredPage != lastConfiguredPage {
            setLastConfiguredPage(configuredPage, for: family)
            setSelectedPage(configuredPage, for: family)
            clearSelectedActivityDay(for: family)
            return configuredPage
        }

        return interactivePage ?? configuredPage
    }

    func selectedActivityDay(for family: WidgetFamilyScope) -> String? {
        guard family != .small, let defaults else {
            clearSelectedActivityDay(for: family)
            return nil
        }
        let key = activityDayKey(for: family)
        guard let date = defaults.string(forKey: key) else { return nil }
        guard WidgetActivityDate.isValid(date) else {
            defaults.removeObject(forKey: key)
            return nil
        }
        return date
    }

    func setSelectedActivityDay(_ date: String, for family: WidgetFamilyScope) {
        guard family != .small, WidgetActivityDate.isValid(date) else {
            clearSelectedActivityDay(for: family)
            return
        }
        defaults?.set(date, forKey: activityDayKey(for: family))
    }

    func clearSelectedActivityDay(for family: WidgetFamilyScope) {
        defaults?.removeObject(forKey: activityDayKey(for: family))
    }

    func clearSelectedActivityDays() {
        clearSelectedActivityDay(for: .medium)
        clearSelectedActivityDay(for: .large)
    }

    static func selectedPageKey(for family: WidgetFamilyScope) -> String {
        "\(selectedPageKeyPrefix).\(family.rawValue)"
    }

    static func lastConfiguredPageKey(for family: WidgetFamilyScope) -> String {
        "\(lastConfiguredPageKeyPrefix).\(family.rawValue)"
    }

    static func selectedActivityDayKey(for family: WidgetFamilyScope) -> String {
        "\(selectedActivityDayKeyPrefix).\(family.rawValue)"
    }

    private func pageKey(for family: WidgetFamilyScope) -> String {
        Self.selectedPageKey(for: family)
    }

    private func lastConfiguredPageKey(for family: WidgetFamilyScope) -> String {
        Self.lastConfiguredPageKey(for: family)
    }

    private func activityDayKey(for family: WidgetFamilyScope) -> String {
        Self.selectedActivityDayKey(for: family)
    }
}

enum WidgetActivityDate {
    // Day keys reach the widget as local wall-clock dates (localDayKey in
    // macWidgetSnapshot.js), so "which day does this key name" and "which day
    // is it now" have to be asked in the same zone. Pinning UTC here put the
    // grid one day off for every user whose local date differed from UTC at
    // render time: east of UTC today was classified as future — drawn as zero,
    // not selectable, and dropped by resolvedDate — while west of UTC the grid
    // grew a phantom trailing day. The zone stays a parameter so tests pin one
    // instead of inheriting whatever the machine happens to be set to.
    static func calendar(timeZone: TimeZone = .current) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.locale = Locale(identifier: "en_US_POSIX")
        calendar.timeZone = timeZone
        return calendar
    }

    static func isValid(_ value: String, timeZone: TimeZone = .current) -> Bool {
        date(from: value, timeZone: timeZone) != nil
    }

    static func date(from value: String, timeZone: TimeZone = .current) -> Date? {
        date(from: value, calendar: calendar(timeZone: timeZone))
    }

    static func date(from value: String, calendar: Calendar) -> Date? {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4,
              parts[1].count == 2,
              parts[2].count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2]),
              let date = calendar.date(from: DateComponents(year: year, month: month, day: day)) else { return nil }
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        guard components.year == year && components.month == month && components.day == day else { return nil }
        return date
    }

    static func startOfDay(_ date: Date, timeZone: TimeZone = .current) -> Date {
        calendar(timeZone: timeZone).startOfDay(for: date)
    }

    static func sunday(for date: Date, timeZone: TimeZone = .current) -> Date {
        let calendar = calendar(timeZone: timeZone)
        let normalized = calendar.startOfDay(for: date)
        let weekday = calendar.component(.weekday, from: normalized)
        return calendar.date(byAdding: .day, value: -(weekday - 1), to: normalized) ?? normalized
    }

    static func addingDays(_ days: Int, to date: Date, timeZone: TimeZone = .current) -> Date {
        calendar(timeZone: timeZone).date(byAdding: .day, value: days, to: date) ?? date
    }
}

enum WidgetActivitySelection {
    static func resolvedDate(
        days: [WidgetActivityDay],
        family: WidgetFamilyScope?,
        referenceDate: Date,
        store: WidgetPresentationStateStoring,
        timeZone: TimeZone = .current
    ) -> String? {
        guard let family, family != .small else { return nil }
        let calendar = WidgetActivityDate.calendar(timeZone: timeZone)
        let datedDays = days.compactMap { WidgetActivityDate.date(from: $0.date, calendar: calendar) }
        guard let selectedDate = store.selectedActivityDay(for: family),
              let selected = WidgetActivityDate.date(from: selectedDate, calendar: calendar),
              let earliest = datedDays.min() else {
            store.clearSelectedActivityDay(for: family)
            return nil
        }
        let maxWeeks = 26
        let reference = WidgetActivityDate.startOfDay(referenceDate, timeZone: timeZone)
        let gridStart = WidgetActivityDate.addingDays(
            -(maxWeeks - 1) * 7,
            to: WidgetActivityDate.sunday(for: reference, timeZone: timeZone),
            timeZone: timeZone
        )
        guard selected >= max(earliest, gridStart), selected <= reference else {
            store.clearSelectedActivityDay(for: family)
            return nil
        }
        return selectedDate
    }

    static func detailDay(
        selectedDate: String?,
        days: [WidgetActivityDay]
    ) -> WidgetActivityDay? {
        guard let selectedDate, WidgetActivityDate.isValid(selectedDate) else { return nil }
        let matches = days.filter { $0.date == selectedDate }
        return WidgetActivityDay(
            date: selectedDate,
            intensity: matches.map(\.intensity).max() ?? 0,
            totalTokens: matches.map(\.totalTokens).max() ?? 0
        )
    }
}

enum WidgetIntentRuntime {
    static var widgetKind: String {
        Bundle.main.object(forInfoDictionaryKey: "TMWidgetKind") as? String ?? "com.tokenmonitor.dashboard"
    }
}

enum WidgetIntentActions {
    static func selectActivityDay(
        family: WidgetFamilyScope,
        date: String,
        store: WidgetPresentationStateStoring,
        widgetKind: String,
        reload: (String) -> Void
    ) {
        guard family == .medium || family == .large, WidgetActivityDate.isValid(date) else {
            store.clearSelectedActivityDay(for: family)
            reload(widgetKind)
            return
        }
        if store.selectedActivityDay(for: family) == date {
            store.clearSelectedActivityDay(for: family)
        } else {
            store.setSelectedActivityDay(date, for: family)
        }
        reload(widgetKind)
    }

    static func setPeriod(
        _ period: WidgetPeriod,
        store: WidgetPresentationStateStoring,
        widgetKind: String,
        reload: (String) -> Void
    ) {
        guard store.selectedPeriod() != period else { return }
        store.setSelectedPeriod(period)
        reload(widgetKind)
    }

    static func cyclePeriod(
        store: WidgetPresentationStateStoring,
        widgetKind: String,
        reload: (String) -> Void
    ) {
        store.setSelectedPeriod(store.selectedPeriod().next)
        reload(widgetKind)
    }

}

struct SelectActivityDayIntent: AppIntent {
    static var title: LocalizedStringResource = "Select Activity Date"
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Widget Size", default: .medium)
    var family: WidgetFamilyScope

    @Parameter(title: "Date")
    var date: String

    init() {
        family = .medium
        date = ""
    }

    init(family: WidgetFamilyScope, date: String) {
        self.family = family
        self.date = date
    }

    func perform() async throws -> some IntentResult {
        WidgetIntentActions.selectActivityDay(
            family: family,
            date: date,
            store: WidgetPresentationStateStore.shared,
            widgetKind: WidgetIntentRuntime.widgetKind,
            reload: { _ in WidgetCenter.shared.reloadAllTimelines() }
        )
        return .result()
    }
}

struct SetWidgetPeriodIntent: AppIntent {
    static var title: LocalizedStringResource = "Set Period"
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Period", default: .day)
    var period: WidgetPeriod

    init() {
        self.period = .day
    }

    init(period: WidgetPeriod) {
        self.period = period
    }

    func perform() async throws -> some IntentResult {
        WidgetIntentActions.setPeriod(
            period,
            store: WidgetPresentationStateStore.shared,
            widgetKind: WidgetIntentRuntime.widgetKind,
            reload: { WidgetCenter.shared.reloadTimelines(ofKind: $0) }
        )
        return .result()
    }
}

struct CycleWidgetPeriodIntent: AppIntent {
    static var title: LocalizedStringResource = "Cycle Period"
    static var openAppWhenRun: Bool { false }

    init() {}

    func perform() async throws -> some IntentResult {
        WidgetIntentActions.cyclePeriod(
            store: WidgetPresentationStateStore.shared,
            widgetKind: WidgetIntentRuntime.widgetKind,
            reload: { WidgetCenter.shared.reloadTimelines(ofKind: $0) }
        )
        return .result()
    }
}
