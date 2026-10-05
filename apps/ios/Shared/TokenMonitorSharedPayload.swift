import Foundation

nonisolated struct TokenMonitorSharedPayload: Codable, Equatable, Sendable {
    static let currentVersion = 1

    var version: Int
    var snapshot: Snapshot?
    var preferences: Preferences

    init(
        version: Int = currentVersion,
        snapshot: Snapshot? = nil,
        preferences: Preferences = .default
    ) {
        self.version = version
        self.snapshot = snapshot
        self.preferences = preferences
    }

    struct Snapshot: Codable, Equatable, Sendable {
        let updatedAt: Date
        let today: Usage
        let month: Usage
        let allTime: Usage
        let limits: [Limit]
        let activity: [Day]

        func usage(for period: String) -> Usage {
            switch period {
            case "month":
                month
            case "allTime":
                allTime
            default:
                today
            }
        }
    }

    struct Usage: Codable, Equatable, Sendable {
        let tokens: Double
        let cost: Double
        let cacheReadTokens: Double
        let outputTokens: Double
        let tools: [Breakdown]
        let models: [Breakdown]

        static let empty = Usage(
            tokens: 0,
            cost: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            tools: [],
            models: []
        )
    }

    struct Breakdown: Codable, Equatable, Identifiable, Sendable {
        let id: String
        let value: Double
    }

    struct Limit: Codable, Equatable, Identifiable, Sendable {
        let id: String
        let providerID: String
        let updatedAt: Date?
        let windows: [LimitWindow]
    }

    struct LimitWindow: Codable, Equatable, Identifiable, Sendable {
        let id: String
        let label: String
        let remainingPercent: Double?
        let amount: Double?
        let currency: String?
        let resetAt: Date?
    }

    struct Day: Codable, Equatable, Identifiable, Sendable {
        let date: String
        let tokens: Double
        let cost: Double

        var id: String { date }
    }

    struct Preferences: Codable, Equatable, Sendable {
        var widgetContent: String
        var widgetPeriod: String
        var widgetProviderID: String?
        var widgetShowsCost: Bool
        var widgetShowsUpdateTime: Bool
        var liveActivityEnabled: Bool
        var livePrimaryMetric: String
        var livePeriod: String
        var liveProviderID: String?
        var liveShowsSecondaryMetric: Bool
        var liveShowsProgress: Bool
        var liveIconProviderID: String?
        var liveCompactTrailingField: String
        var liveExpandedLeadingField: String
        var liveExpandedCenterField: String
        var liveExpandedTrailingField: String
        var liveExpandedBottomField: String
        var liveLockScreenPrimaryField: String
        var liveLockScreenSecondaryField: String
        var liveLockScreenBottomField: String
        var currencyCode: String?
        var languageCode: String?

        init(
            widgetContent: String = "overview",
            widgetPeriod: String = "today",
            widgetProviderID: String? = nil,
            widgetShowsCost: Bool = true,
            widgetShowsUpdateTime: Bool = true,
            liveActivityEnabled: Bool = false,
            livePrimaryMetric: String = "tokens",
            livePeriod: String = "today",
            liveProviderID: String? = nil,
            liveShowsSecondaryMetric: Bool = true,
            liveShowsProgress: Bool = true,
            liveIconProviderID: String? = nil,
            liveCompactTrailingField: String = "primary",
            liveExpandedLeadingField: String = "provider",
            liveExpandedCenterField: String = "primary",
            liveExpandedTrailingField: String = "secondary",
            liveExpandedBottomField: String = "progress",
            liveLockScreenPrimaryField: String = "primary",
            liveLockScreenSecondaryField: String = "secondary",
            liveLockScreenBottomField: String = "progress",
            currencyCode: String? = "USD",
            languageCode: String? = "auto"
        ) {
            self.widgetContent = widgetContent
            self.widgetPeriod = widgetPeriod
            self.widgetProviderID = widgetProviderID
            self.widgetShowsCost = widgetShowsCost
            self.widgetShowsUpdateTime = widgetShowsUpdateTime
            self.liveActivityEnabled = liveActivityEnabled
            self.livePrimaryMetric = livePrimaryMetric
            self.livePeriod = livePeriod
            self.liveProviderID = liveProviderID
            self.liveShowsSecondaryMetric = liveShowsSecondaryMetric
            self.liveShowsProgress = liveShowsProgress
            self.liveIconProviderID = liveIconProviderID
            self.liveCompactTrailingField = liveCompactTrailingField
            self.liveExpandedLeadingField = liveExpandedLeadingField
            self.liveExpandedCenterField = liveExpandedCenterField
            self.liveExpandedTrailingField = liveExpandedTrailingField
            self.liveExpandedBottomField = liveExpandedBottomField
            self.liveLockScreenPrimaryField = liveLockScreenPrimaryField
            self.liveLockScreenSecondaryField = liveLockScreenSecondaryField
            self.liveLockScreenBottomField = liveLockScreenBottomField
            self.currencyCode = currencyCode
            self.languageCode = languageCode
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            self.init(
                widgetContent: try container.decodeIfPresent(
                    String.self,
                    forKey: .widgetContent
                ) ?? "overview",
                widgetPeriod: try container.decodeIfPresent(
                    String.self,
                    forKey: .widgetPeriod
                ) ?? "today",
                widgetProviderID: try container.decodeIfPresent(
                    String.self,
                    forKey: .widgetProviderID
                ),
                widgetShowsCost: try container.decodeIfPresent(
                    Bool.self,
                    forKey: .widgetShowsCost
                ) ?? true,
                widgetShowsUpdateTime: try container.decodeIfPresent(
                    Bool.self,
                    forKey: .widgetShowsUpdateTime
                ) ?? true,
                liveActivityEnabled: try container.decodeIfPresent(
                    Bool.self,
                    forKey: .liveActivityEnabled
                ) ?? false,
                livePrimaryMetric: try container.decodeIfPresent(
                    String.self,
                    forKey: .livePrimaryMetric
                ) ?? "tokens",
                livePeriod: try container.decodeIfPresent(
                    String.self,
                    forKey: .livePeriod
                ) ?? "today",
                liveProviderID: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveProviderID
                ),
                liveShowsSecondaryMetric: try container.decodeIfPresent(
                    Bool.self,
                    forKey: .liveShowsSecondaryMetric
                ) ?? true,
                liveShowsProgress: try container.decodeIfPresent(
                    Bool.self,
                    forKey: .liveShowsProgress
                ) ?? true,
                liveIconProviderID: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveIconProviderID
                ),
                liveCompactTrailingField: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveCompactTrailingField
                ) ?? "primary",
                liveExpandedLeadingField: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveExpandedLeadingField
                ) ?? "provider",
                liveExpandedCenterField: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveExpandedCenterField
                ) ?? "primary",
                liveExpandedTrailingField: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveExpandedTrailingField
                ) ?? "secondary",
                liveExpandedBottomField: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveExpandedBottomField
                ) ?? "progress",
                liveLockScreenPrimaryField: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveLockScreenPrimaryField
                ) ?? "primary",
                liveLockScreenSecondaryField: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveLockScreenSecondaryField
                ) ?? "secondary",
                liveLockScreenBottomField: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveLockScreenBottomField
                ) ?? "progress",
                currencyCode: try container.decodeIfPresent(
                    String.self,
                    forKey: .currencyCode
                ) ?? "USD",
                languageCode: try container.decodeIfPresent(
                    String.self,
                    forKey: .languageCode
                ) ?? "auto"
            )
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(widgetContent, forKey: .widgetContent)
            try container.encode(widgetPeriod, forKey: .widgetPeriod)
            try container.encodeIfPresent(widgetProviderID, forKey: .widgetProviderID)
            try container.encode(widgetShowsCost, forKey: .widgetShowsCost)
            try container.encode(widgetShowsUpdateTime, forKey: .widgetShowsUpdateTime)
            try container.encode(liveActivityEnabled, forKey: .liveActivityEnabled)
            try container.encode(livePrimaryMetric, forKey: .livePrimaryMetric)
            try container.encode(livePeriod, forKey: .livePeriod)
            try container.encodeIfPresent(liveProviderID, forKey: .liveProviderID)
            try container.encode(
                liveShowsSecondaryMetric,
                forKey: .liveShowsSecondaryMetric
            )
            try container.encode(liveShowsProgress, forKey: .liveShowsProgress)
            try container.encodeIfPresent(
                liveIconProviderID,
                forKey: .liveIconProviderID
            )
            try container.encode(
                liveCompactTrailingField,
                forKey: .liveCompactTrailingField
            )
            try container.encode(
                liveExpandedLeadingField,
                forKey: .liveExpandedLeadingField
            )
            try container.encode(
                liveExpandedCenterField,
                forKey: .liveExpandedCenterField
            )
            try container.encode(
                liveExpandedTrailingField,
                forKey: .liveExpandedTrailingField
            )
            try container.encode(
                liveExpandedBottomField,
                forKey: .liveExpandedBottomField
            )
            try container.encode(
                liveLockScreenPrimaryField,
                forKey: .liveLockScreenPrimaryField
            )
            try container.encode(
                liveLockScreenSecondaryField,
                forKey: .liveLockScreenSecondaryField
            )
            try container.encode(
                liveLockScreenBottomField,
                forKey: .liveLockScreenBottomField
            )
            try container.encodeIfPresent(currencyCode, forKey: .currencyCode)
            try container.encodeIfPresent(languageCode, forKey: .languageCode)
        }

        private enum CodingKeys: String, CodingKey {
            case widgetContent
            case widgetPeriod
            case widgetProviderID
            case widgetShowsCost
            case widgetShowsUpdateTime
            case liveActivityEnabled
            case livePrimaryMetric
            case livePeriod
            case liveProviderID
            case liveShowsSecondaryMetric
            case liveShowsProgress
            case liveIconProviderID
            case liveCompactTrailingField
            case liveExpandedLeadingField
            case liveExpandedCenterField
            case liveExpandedTrailingField
            case liveExpandedBottomField
            case liveLockScreenPrimaryField
            case liveLockScreenSecondaryField
            case liveLockScreenBottomField
            case currencyCode
            case languageCode
        }

        static let `default` = Preferences(
            widgetContent: "overview",
            widgetPeriod: "today",
            widgetProviderID: nil,
            widgetShowsCost: true,
            widgetShowsUpdateTime: true,
            liveActivityEnabled: false,
            livePrimaryMetric: "tokens",
            livePeriod: "today",
            liveProviderID: nil,
            liveShowsSecondaryMetric: true,
            liveShowsProgress: true,
            liveIconProviderID: nil,
            liveCompactTrailingField: "primary",
            liveExpandedLeadingField: "provider",
            liveExpandedCenterField: "primary",
            liveExpandedTrailingField: "secondary",
            liveExpandedBottomField: "progress",
            liveLockScreenPrimaryField: "primary",
            liveLockScreenSecondaryField: "secondary",
            liveLockScreenBottomField: "progress",
            currencyCode: "USD",
            languageCode: "auto"
        )
    }
}
