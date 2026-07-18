import AppIntents
import Foundation
import WidgetKit

enum WidgetPage: String, AppEnum, CaseIterable {
    case overview
    case quota
    case models
    case activity
    case trend

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Display Page")
    static let caseDisplayRepresentations: [WidgetPage: DisplayRepresentation] = [
        .overview: DisplayRepresentation(title: "Overview", image: .init(systemName: "house")),
        .quota: DisplayRepresentation(title: "Quota", image: .init(systemName: "gauge.with.dots.needle.50percent")),
        .models: DisplayRepresentation(title: "Models", image: .init(systemName: "cpu")),
        .activity: DisplayRepresentation(title: "Activity", image: .init(systemName: "square.grid.3x3")),
        .trend: DisplayRepresentation(title: "Trend", image: .init(systemName: "chart.xyaxis.line"))
    ]

    var title: String {
        switch self {
        case .overview: WidgetL10n.text("Overview")
        case .quota: WidgetL10n.text("Quota")
        case .models: WidgetL10n.text("Models")
        case .activity: WidgetL10n.text("Activity")
        case .trend: WidgetL10n.text("Trend")
        }
    }

    var systemImage: String {
        switch self {
        case .overview: "house"
        case .quota: "gauge.with.dots.needle.50percent"
        case .models: "cpu"
        case .activity: "square.grid.3x3"
        case .trend: "chart.xyaxis.line"
        }
    }

    var next: WidgetPage {
        switch self {
        case .overview: .quota
        case .quota: .models
        case .models: .activity
        case .activity: .trend
        case .trend: .overview
        }
    }
}

struct TokenMonitorWidgetConfigurationIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Token Monitor Page"
    static let description = IntentDescription("Choose the page shown by this widget instance.")

    @Parameter(title: "Display Page", default: .overview)
    var page: WidgetPage
}

enum WidgetPeriod: String, Codable, AppEnum, CaseIterable {
    case day
    case month
    case total

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Period")
    static let caseDisplayRepresentations: [WidgetPeriod: DisplayRepresentation] = [
        .day: DisplayRepresentation(title: "DAY", subtitle: "Today"),
        .month: DisplayRepresentation(title: "MONTH", subtitle: "This month"),
        .total: DisplayRepresentation(title: "TOTAL", subtitle: "All time")
    ]

    var title: String {
        switch self {
        case .day: WidgetL10n.text("DAY")
        case .month: WidgetL10n.text("MONTH")
        case .total: WidgetL10n.text("TOTAL")
        }
    }

    var accessibilityName: String {
        switch self {
        case .day: WidgetL10n.text("Today usage")
        case .month: WidgetL10n.text("This month usage")
        case .total: WidgetL10n.text("All-time usage")
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
    private static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }()

    static func isValid(_ value: String) -> Bool {
        date(from: value) != nil
    }

    static func date(from value: String) -> Date? {
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

    static func startOfDay(_ date: Date) -> Date {
        calendar.startOfDay(for: date)
    }

    static func sunday(for date: Date) -> Date {
        let normalized = startOfDay(date)
        let weekday = calendar.component(.weekday, from: normalized)
        return calendar.date(byAdding: .day, value: -(weekday - 1), to: normalized) ?? normalized
    }

    static func addingDays(_ days: Int, to date: Date) -> Date {
        calendar.date(byAdding: .day, value: days, to: date) ?? date
    }
}

enum WidgetActivitySelection {
    static func resolvedDate(
        days: [WidgetActivityDay],
        family: WidgetFamilyScope?,
        referenceDate: Date,
        store: WidgetPresentationStateStoring
    ) -> String? {
        guard let family, family != .small else { return nil }
        let datedDays = days.compactMap { WidgetActivityDate.date(from: $0.date) }
        guard let selectedDate = store.selectedActivityDay(for: family),
              let selected = WidgetActivityDate.date(from: selectedDate),
              let earliest = datedDays.min() else {
            store.clearSelectedActivityDay(for: family)
            return nil
        }
        let maxWeeks = family == .medium ? 14 : 26
        let reference = WidgetActivityDate.startOfDay(referenceDate)
        let gridStart = WidgetActivityDate.addingDays(
            -(maxWeeks - 1) * 7,
            to: WidgetActivityDate.sunday(for: reference)
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
        store.clearSelectedActivityDays()
        store.setSelectedPeriod(period)
        reload(widgetKind)
    }

    static func cyclePeriod(
        store: WidgetPresentationStateStoring,
        widgetKind: String,
        reload: (String) -> Void
    ) {
        store.clearSelectedActivityDays()
        store.setSelectedPeriod(store.selectedPeriod().next)
        reload(widgetKind)
    }

    static func cyclePage(
        family: WidgetFamilyScope,
        currentPage: WidgetPage,
        store: WidgetPresentationStateStoring,
        widgetKind: String,
        reload: (String) -> Void
    ) {
        store.clearSelectedActivityDay(for: family)
        let current = store.selectedPage(for: family) ?? currentPage
        store.setSelectedPage(current.next, for: family)
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
            reload: { WidgetCenter.shared.reloadTimelines(ofKind: $0) }
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

struct CycleWidgetPageIntent: AppIntent {
    static var title: LocalizedStringResource = "Cycle Widget Page"
    static var description = IntentDescription("Switch the page shown by the current widget size.")
    static var openAppWhenRun: Bool { false }

    @Parameter(title: "Widget Size", default: .small)
    var family: WidgetFamilyScope

    @Parameter(title: "Current Page", default: .overview)
    var currentPage: WidgetPage

    init() {
        self.family = .small
        self.currentPage = .overview
    }

    init(family: WidgetFamilyScope, currentPage: WidgetPage) {
        self.family = family
        self.currentPage = currentPage
    }

    func perform() async throws -> some IntentResult {
        WidgetIntentActions.cyclePage(
            family: family,
            currentPage: currentPage,
            store: WidgetPresentationStateStore.shared,
            widgetKind: WidgetIntentRuntime.widgetKind,
            reload: { WidgetCenter.shared.reloadTimelines(ofKind: $0) }
        )
        return .result()
    }
}
