import Foundation

// Widget target only: resolves the configuration intent into the concrete
// values the view consumes. The app target never sees AppIntents types.
extension TokenMonitorWidgetEntry {
    init(
        date: Date,
        snapshot: TokenMonitorSharedPayload.Snapshot?,
        preferences: TokenMonitorSharedPayload.Preferences,
        configuration: TokenMonitorWidgetIntent
    ) {
        let selectedProvider = configuration.provider?.id ?? preferences.widgetProviderID
        self.init(
            date: date,
            snapshot: snapshot,
            preferences: preferences,
            content: configuration.content == .appDefault
                ? preferences.widgetContent
                : configuration.content.rawValue,
            period: configuration.period == .appDefault
                ? preferences.widgetPeriod
                : configuration.period.rawValue,
            providerID: selectedProvider.flatMap { $0.isEmpty ? nil : $0 },
            showsCost: configuration.costVisibility.resolve(preferences.widgetShowsCost),
            showsUpdateTime: configuration.updateTimeVisibility.resolve(preferences.widgetShowsUpdateTime),
            ink: WidgetInk(configuration.textContrast)
        )
    }
}

private extension WidgetVisibilityOption {
    func resolve(_ fallback: Bool) -> Bool {
        switch self {
        case .appDefault: fallback
        case .show: true
        case .hide: false
        }
    }
}

private extension WidgetInk {
    init(_ option: WidgetTextContrastOption) {
        switch option {
        case .recommended: self = .recommended
        case .light: self = .light
        case .dark: self = .dark
        }
    }
}
