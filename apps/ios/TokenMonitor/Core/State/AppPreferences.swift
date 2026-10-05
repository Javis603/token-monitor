import Foundation
import Observation
import WidgetKit

@MainActor
@Observable
final class AppPreferences {
    enum WidgetContent: String, CaseIterable, Identifiable {
        case overview
        case limits
        case activity

        var id: String { rawValue }

        var title: String {
            switch self {
            case .overview:
                "Usage overview"
            case .limits:
                "AI limits"
            case .activity:
                "Activity heatmap"
            }
        }

        var systemImage: String {
            switch self {
            case .overview: "chart.bar.xaxis"
            case .limits: "gauge"
            case .activity: "chart.line.uptrend.xyaxis"
            }
        }
    }

    enum LiveMetric: String, CaseIterable, Identifiable {
        case tokens
        case cost
        case limit

        var id: String { rawValue }

        var title: String {
            switch self {
            case .tokens:
                "Tokens"
            case .cost:
                "Cost"
            case .limit:
                "AI limit"
            }
        }
    }

    var appearance: AppAppearance {
        didSet { persistLocalPreferences() }
    }

    var homeLimitCount: Int {
        didSet {
            let clamped = min(8, max(1, homeLimitCount))
            guard clamped == homeLimitCount else {
                homeLimitCount = clamped
                return
            }
            persistLocalPreferences()
        }
    }

    var currency: AppCurrency {
        didSet {
            persistLocalPreferences()
            persistSharedPreferences()
        }
    }

    var language: AppLanguage {
        didSet {
            persistLocalPreferences()
            persistSharedPreferences()
        }
    }

    var widgetContent: WidgetContent {
        didSet { persistSharedPreferences() }
    }

    var widgetPeriod: UsagePeriodKey {
        didSet { persistSharedPreferences() }
    }

    var widgetProviderID: String {
        didSet { persistSharedPreferences() }
    }

    var widgetShowsCost: Bool {
        didSet { persistSharedPreferences() }
    }

    var widgetShowsUpdateTime: Bool {
        didSet { persistSharedPreferences() }
    }

    var liveActivityEnabled: Bool {
        didSet { persistSharedPreferences() }
    }

    var livePrimaryMetric: LiveMetric {
        didSet { persistSharedPreferences() }
    }

    var livePeriod: UsagePeriodKey {
        didSet { persistSharedPreferences() }
    }

    var liveProviderID: String {
        didSet { persistSharedPreferences() }
    }

    var liveShowsSecondaryMetric: Bool {
        didSet { persistSharedPreferences() }
    }

    var liveShowsProgress: Bool {
        didSet { persistSharedPreferences() }
    }

    var liveIconProviderID: String {
        didSet { persistSharedPreferences() }
    }

    var liveCompactTrailingField: String {
        didSet { persistSharedPreferences() }
    }

    var liveExpandedLeadingField: String {
        didSet { persistSharedPreferences() }
    }

    var liveExpandedCenterField: String {
        didSet { persistSharedPreferences() }
    }

    var liveExpandedTrailingField: String {
        didSet { persistSharedPreferences() }
    }

    var liveExpandedBottomField: String {
        didSet { persistSharedPreferences() }
    }

    var liveLockScreenPrimaryField: String {
        didSet { persistSharedPreferences() }
    }

    var liveLockScreenSecondaryField: String {
        didSet { persistSharedPreferences() }
    }

    var liveLockScreenBottomField: String {
        didSet { persistSharedPreferences() }
    }

    @ObservationIgnored
    private let defaults: UserDefaults

    @ObservationIgnored
    private let snapshotStore: SharedSnapshotStore

    init(
        defaults: UserDefaults = .standard,
        snapshotStore: SharedSnapshotStore = SharedSnapshotStore()
    ) {
        self.defaults = defaults
        self.snapshotStore = snapshotStore

        appearance = AppAppearance(
            rawValue: defaults.string(forKey: Keys.appearance) ?? ""
        ) ?? .system
        homeLimitCount = min(
            8,
            max(1, defaults.object(forKey: Keys.homeLimitCount) as? Int ?? 3)
        )
        currency = AppCurrency(
            rawValue: defaults.string(forKey: Keys.currency) ?? ""
        ) ?? .usd
        language = AppLanguage(
            rawValue: defaults.string(forKey: Keys.language) ?? ""
        ) ?? .system

        let shared = (try? snapshotStore.load().preferences) ?? .default
        widgetContent = WidgetContent(rawValue: shared.widgetContent) ?? .overview
        widgetPeriod = UsagePeriodKey(rawValue: shared.widgetPeriod) ?? .today
        widgetProviderID = shared.widgetProviderID ?? ""
        widgetShowsCost = shared.widgetShowsCost
        widgetShowsUpdateTime = shared.widgetShowsUpdateTime
        liveActivityEnabled = shared.liveActivityEnabled
        livePrimaryMetric = LiveMetric(rawValue: shared.livePrimaryMetric) ?? .tokens
        livePeriod = UsagePeriodKey(rawValue: shared.livePeriod) ?? .today
        liveProviderID = shared.liveProviderID ?? ""
        liveShowsSecondaryMetric = shared.liveShowsSecondaryMetric
        liveShowsProgress = shared.liveShowsProgress
        liveIconProviderID = shared.liveIconProviderID ?? ""
        liveCompactTrailingField = shared.liveCompactTrailingField
        liveExpandedLeadingField = shared.liveExpandedLeadingField
        liveExpandedCenterField = shared.liveExpandedCenterField
        liveExpandedTrailingField = shared.liveExpandedTrailingField
        liveExpandedBottomField = shared.liveExpandedBottomField
        liveLockScreenPrimaryField = shared.liveLockScreenPrimaryField
        liveLockScreenSecondaryField = shared.liveShowsSecondaryMetric
            ? shared.liveLockScreenSecondaryField
            : TokenMonitorActivityAttributes.Field.none.rawValue
        liveLockScreenBottomField = shared.liveShowsProgress
            ? shared.liveLockScreenBottomField
            : TokenMonitorActivityAttributes.Field.none.rawValue
    }

    var sharedPreferences: TokenMonitorSharedPayload.Preferences {
        TokenMonitorSharedPayload.Preferences(
            widgetContent: widgetContent.rawValue,
            widgetPeriod: widgetPeriod.rawValue,
            widgetProviderID: widgetProviderID.nilIfEmpty,
            widgetShowsCost: widgetShowsCost,
            widgetShowsUpdateTime: widgetShowsUpdateTime,
            liveActivityEnabled: liveActivityEnabled,
            livePrimaryMetric: livePrimaryMetric.rawValue,
            livePeriod: livePeriod.rawValue,
            liveProviderID: liveProviderID.nilIfEmpty,
            liveShowsSecondaryMetric: liveShowsSecondaryMetric,
            liveShowsProgress: liveShowsProgress,
            liveIconProviderID: liveIconProviderID.nilIfEmpty,
            liveCompactTrailingField: liveCompactTrailingField,
            liveExpandedLeadingField: liveExpandedLeadingField,
            liveExpandedCenterField: liveExpandedCenterField,
            liveExpandedTrailingField: liveExpandedTrailingField,
            liveExpandedBottomField: liveExpandedBottomField,
            liveLockScreenPrimaryField: liveLockScreenPrimaryField,
            liveLockScreenSecondaryField: liveLockScreenSecondaryField,
            liveLockScreenBottomField: liveLockScreenBottomField,
            currencyCode: currency.rawValue,
            languageCode: language.rawValue
        )
    }

    private func persistLocalPreferences() {
        defaults.set(appearance.rawValue, forKey: Keys.appearance)
        defaults.set(homeLimitCount, forKey: Keys.homeLimitCount)
        defaults.set(currency.rawValue, forKey: Keys.currency)
        defaults.set(language.rawValue, forKey: Keys.language)
    }

    private func persistSharedPreferences() {
        try? snapshotStore.updatePreferences(sharedPreferences)
        WidgetCenter.shared.reloadAllTimelines()
    }

    private enum Keys {
        static let appearance = "appearance"
        static let homeLimitCount = "homeLimitCount"
        static let currency = "currency"
        static let language = "language"
    }
}

extension AppPreferences {
    static var preview: AppPreferences {
        let defaults = UserDefaults(suiteName: "TokenMonitorPreferencesPreview") ?? .standard
        return AppPreferences(
            defaults: defaults,
            snapshotStore: SharedSnapshotStore(fileURL: nil)
        )
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
