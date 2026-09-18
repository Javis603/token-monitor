import AppIntents
import Foundation
import WidgetKit

enum WidgetPage: String, CaseIterable {
    case overview
    case quota
    case tools
    case models
    case activity

    var title: String {
        switch self {
        case .overview: WidgetL10n.text("Overview")
        case .quota: WidgetL10n.text("Quota")
        case .tools: WidgetL10n.text("Tools")
        case .models: WidgetL10n.text("Models")
        case .activity: WidgetL10n.text("Activity")
        }
    }
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

enum WidgetQuotaMode: String, AppEnum, CaseIterable {
    case automatic
    case custom

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Quota Mode")
    static let caseDisplayRepresentations: [WidgetQuotaMode: DisplayRepresentation] = [
        .automatic: DisplayRepresentation(title: "Automatic"),
        .custom: DisplayRepresentation(title: "Custom")
    ]
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

struct DashboardWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Dashboard"
    static let description = IntentDescription("Choose the dashboard period, breakdown, and quota display mode.")

    @Parameter(title: "Period", default: .day)
    var period: WidgetPeriod

    @Parameter(title: "Breakdown", default: .models)
    var breakdown: WidgetBreakdown

    @Parameter(title: "Quota Mode", default: .automatic)
    var quotaMode: WidgetQuotaMode

    @Parameter(title: "Quota 1")
    var primaryQuota: WidgetQuotaSelection?

    @Parameter(title: "Quota 2")
    var secondaryQuota: WidgetSecondaryQuotaSelection?
}

struct QuotaWidgetIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "Quota"
    static let description = IntentDescription("Show quota accounts automatically or choose up to two.")

    @Parameter(title: "Quota Mode", default: .automatic)
    var quotaMode: WidgetQuotaMode

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
                name: selection.name
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
                name: selection.name
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
}

enum WidgetPeriodPolicy {
    static func isSelectable(on page: WidgetPage) -> Bool {
        page == .overview || page == .tools || page == .models
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
    case medium
    case large

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Widget Size")
    static let caseDisplayRepresentations: [WidgetFamilyScope: DisplayRepresentation] = [
        .medium: DisplayRepresentation(title: "Medium"),
        .large: DisplayRepresentation(title: "Large")
    ]

    init?(widgetFamily: WidgetFamily) {
        switch widgetFamily {
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
    func selectedActivityDay(for family: WidgetFamilyScope) -> String?
    func setSelectedActivityDay(_ date: String, for family: WidgetFamilyScope)
    func clearSelectedActivityDay(for family: WidgetFamilyScope)
}

final class WidgetPresentationStateStore: WidgetPresentationStateStoring {
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

    func selectedActivityDay(for family: WidgetFamilyScope) -> String? {
        guard let defaults else { return nil }
        let key = Self.selectedActivityDayKey(for: family)
        guard let date = defaults.string(forKey: key) else { return nil }
        guard WidgetActivityDate.isValid(date) else {
            defaults.removeObject(forKey: key)
            return nil
        }
        return date
    }

    func setSelectedActivityDay(_ date: String, for family: WidgetFamilyScope) {
        guard WidgetActivityDate.isValid(date) else {
            clearSelectedActivityDay(for: family)
            return
        }
        defaults?.set(date, forKey: Self.selectedActivityDayKey(for: family))
    }

    func clearSelectedActivityDay(for family: WidgetFamilyScope) {
        defaults?.removeObject(forKey: Self.selectedActivityDayKey(for: family))
    }

    static func selectedActivityDayKey(for family: WidgetFamilyScope) -> String {
        "\(selectedActivityDayKeyPrefix).\(family.rawValue)"
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
    static func selectedDay(in days: [WidgetActivityDay], selectedDate: String?) -> WidgetActivityDay? {
        guard let selectedDate else { return nil }
        return days.first { $0.date == selectedDate }
            ?? WidgetActivityDay(date: selectedDate, intensity: 0, totalTokens: 0, costUsd: 0)
    }

    static func resolvedDate(
        days: [WidgetActivityDay],
        family: WidgetFamilyScope?,
        referenceDate: Date,
        store: WidgetPresentationStateStoring,
        timeZone: TimeZone = .current
    ) -> String? {
        guard let family else { return nil }
        let calendar = WidgetActivityDate.calendar(timeZone: timeZone)
        let datedDays = days.compactMap { WidgetActivityDate.date(from: $0.date, calendar: calendar) }
        guard let selectedDate = store.selectedActivityDay(for: family),
              let selected = WidgetActivityDate.date(from: selectedDate, calendar: calendar),
              let earliest = datedDays.min() else {
            store.clearSelectedActivityDay(for: family)
            return nil
        }
        let maxWeeks = WidgetActivityCoverage.maxWeeks(for: family)
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
}

enum WidgetActivityCoverage {
    static func maxWeeks(for family: WidgetFamilyScope) -> Int {
        switch family {
        case .medium: 26
        case .large: 16
        }
    }
}

enum WidgetIntentActions {
    static func refresh(reload: () -> Void) {
        reload()
    }

    static func selectActivityDay(
        family: WidgetFamilyScope,
        date: String,
        store: WidgetPresentationStateStoring,
        reload: () -> Void
    ) {
        guard WidgetActivityDate.isValid(date) else {
            store.clearSelectedActivityDay(for: family)
            reload()
            return
        }
        if store.selectedActivityDay(for: family) == date {
            store.clearSelectedActivityDay(for: family)
        } else {
            store.setSelectedActivityDay(date, for: family)
        }
        reload()
    }
}

struct RefreshWidgetIntent: AppIntent {
    static var title: LocalizedStringResource = "Refresh Widget"
    static var openAppWhenRun: Bool { false }
    static var isDiscoverable: Bool { false }

    func perform() async throws -> some IntentResult {
        WidgetIntentActions.refresh {
            WidgetCenter.shared.reloadAllTimelines()
        }
        return .result()
    }
}

struct SelectActivityDayIntent: AppIntent {
    static var title: LocalizedStringResource = "Select Activity Date"
    static var openAppWhenRun: Bool { false }
    static var isDiscoverable: Bool { false }

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
            reload: { WidgetCenter.shared.reloadAllTimelines() }
        )
        return .result()
    }
}
