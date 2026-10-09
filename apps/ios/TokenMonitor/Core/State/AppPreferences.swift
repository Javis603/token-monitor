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

    /// Limits provider order; empty means the desktop catalog order.
    var limitProviderOrder: [String] {
        didSet {
            persistLocalPreferences()
            persistSharedPreferences()
        }
    }

    var hiddenLimitProviders: Set<String> {
        didSet {
            persistLocalPreferences()
            persistSharedPreferences()
        }
    }

    var masksAccountEmails: Bool {
        didSet { persistLocalPreferences() }
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

    /// Device-side Live Activity presentation; the widget extension reads it
    /// from the app group, so it never reaches the Hub.
    var liveLayout: LiveActivityLayout {
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
        limitProviderOrder = defaults.stringArray(forKey: Keys.limitProviderOrder) ?? []
        hiddenLimitProviders = Set(
            defaults.stringArray(forKey: Keys.hiddenLimitProviders) ?? []
        )
        masksAccountEmails = defaults.object(forKey: Keys.masksAccountEmails) as? Bool ?? true
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
        liveLayout = shared.liveLayout
    }

    var sharedPreferences: TokenMonitorSharedPayload.Preferences {
        TokenMonitorSharedPayload.Preferences(
            widgetContent: widgetContent.rawValue,
            widgetPeriod: widgetPeriod.rawValue,
            widgetProviderID: widgetProviderID.nilIfEmpty,
            widgetShowsCost: widgetShowsCost,
            widgetShowsUpdateTime: widgetShowsUpdateTime,
            liveActivityEnabled: liveActivityEnabled,
            liveLayout: liveLayout,
            currencyCode: currency.rawValue,
            languageCode: language.rawValue,
            limitProviderOrder: limitProviderOrder,
            hiddenLimitProviders: hiddenLimitProviders.sorted()
        )
    }

    private func persistLocalPreferences() {
        defaults.set(appearance.rawValue, forKey: Keys.appearance)
        defaults.set(homeLimitCount, forKey: Keys.homeLimitCount)
        defaults.set(currency.rawValue, forKey: Keys.currency)
        defaults.set(language.rawValue, forKey: Keys.language)
        defaults.set(limitProviderOrder, forKey: Keys.limitProviderOrder)
        defaults.set(hiddenLimitProviders.sorted(), forKey: Keys.hiddenLimitProviders)
        defaults.set(masksAccountEmails, forKey: Keys.masksAccountEmails)
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
        static let limitProviderOrder = "limitProviderOrder"
        static let hiddenLimitProviders = "hiddenLimitProviders"
        static let masksAccountEmails = "masksAccountEmails"
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
