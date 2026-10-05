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
        var sourceStale: Bool? = nil

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
        // Additive metadata keeps the numeric widget API and old cache decoding.
        var tokensKnown: Bool? = nil
        var costKnown: Bool? = nil
        var tokenComponentsKnown: Bool? = nil
        var throughputKnown: Bool? = nil
        var unclassifiedTokens: Double? = nil

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
        let planLabel: String?
        let status: String?
        let updatedAt: Date?
        let windows: [LimitWindow]
        var sourceStale: Bool? = nil
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
        var livePeriod: String
        var liveProviderID: String?
        var liveCompactLeading: String
        var liveCompactTrailing: String
        var liveExpandedStyle: String
        var liveLockScreenStyle: String
        var currencyCode: String?
        var languageCode: String?
        var limitProviderOrder: [String]?
        var hiddenLimitProviders: [String]?

        init(
            widgetContent: String = "overview",
            widgetPeriod: String = "today",
            widgetProviderID: String? = nil,
            widgetShowsCost: Bool = true,
            widgetShowsUpdateTime: Bool = true,
            liveActivityEnabled: Bool = false,
            livePeriod: String = "today",
            liveProviderID: String? = nil,
            liveCompactLeading: String = "mark",
            liveCompactTrailing: String = "percent",
            liveExpandedStyle: String = "quota",
            liveLockScreenStyle: String = "combined",
            currencyCode: String? = "USD",
            languageCode: String? = "auto",
            limitProviderOrder: [String]? = nil,
            hiddenLimitProviders: [String]? = nil
        ) {
            self.widgetContent = widgetContent
            self.widgetPeriod = widgetPeriod
            self.widgetProviderID = widgetProviderID
            self.widgetShowsCost = widgetShowsCost
            self.widgetShowsUpdateTime = widgetShowsUpdateTime
            self.liveActivityEnabled = liveActivityEnabled
            self.livePeriod = livePeriod
            self.liveProviderID = liveProviderID
            self.liveCompactLeading = liveCompactLeading
            self.liveCompactTrailing = liveCompactTrailing
            self.liveExpandedStyle = liveExpandedStyle
            self.liveLockScreenStyle = liveLockScreenStyle
            self.currencyCode = currencyCode
            self.languageCode = languageCode
            self.limitProviderOrder = limitProviderOrder
            self.hiddenLimitProviders = hiddenLimitProviders
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
                livePeriod: try container.decodeIfPresent(
                    String.self,
                    forKey: .livePeriod
                ) ?? "today",
                liveProviderID: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveProviderID
                ),
                liveCompactLeading: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveCompactLeading
                ) ?? "mark",
                liveCompactTrailing: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveCompactTrailing
                ) ?? "percent",
                liveExpandedStyle: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveExpandedStyle
                ) ?? "quota",
                liveLockScreenStyle: try container.decodeIfPresent(
                    String.self,
                    forKey: .liveLockScreenStyle
                ) ?? "combined",
                currencyCode: try container.decodeIfPresent(
                    String.self,
                    forKey: .currencyCode
                ) ?? "USD",
                languageCode: try container.decodeIfPresent(
                    String.self,
                    forKey: .languageCode
                ) ?? "auto",
                limitProviderOrder: try container.decodeIfPresent(
                    [String].self,
                    forKey: .limitProviderOrder
                ),
                hiddenLimitProviders: try container.decodeIfPresent(
                    [String].self,
                    forKey: .hiddenLimitProviders
                )
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
            try container.encode(livePeriod, forKey: .livePeriod)
            try container.encodeIfPresent(liveProviderID, forKey: .liveProviderID)
            try container.encode(liveCompactLeading, forKey: .liveCompactLeading)
            try container.encode(liveCompactTrailing, forKey: .liveCompactTrailing)
            try container.encode(liveExpandedStyle, forKey: .liveExpandedStyle)
            try container.encode(liveLockScreenStyle, forKey: .liveLockScreenStyle)
            try container.encodeIfPresent(currencyCode, forKey: .currencyCode)
            try container.encodeIfPresent(languageCode, forKey: .languageCode)
            try container.encodeIfPresent(
                limitProviderOrder,
                forKey: .limitProviderOrder
            )
            try container.encodeIfPresent(
                hiddenLimitProviders,
                forKey: .hiddenLimitProviders
            )
        }

        private enum CodingKeys: String, CodingKey {
            case widgetContent
            case widgetPeriod
            case widgetProviderID
            case widgetShowsCost
            case widgetShowsUpdateTime
            case liveActivityEnabled
            case livePeriod
            case liveProviderID
            case liveCompactLeading
            case liveCompactTrailing
            case liveExpandedStyle
            case liveLockScreenStyle
            case currencyCode
            case languageCode
            case limitProviderOrder
            case hiddenLimitProviders
        }

        static let `default` = Preferences(
            widgetContent: "overview",
            widgetPeriod: "today",
            widgetProviderID: nil,
            widgetShowsCost: true,
            widgetShowsUpdateTime: true,
            liveActivityEnabled: false,
            livePeriod: "today",
            liveProviderID: nil,
            liveCompactLeading: "mark",
            liveCompactTrailing: "percent",
            liveExpandedStyle: "quota",
            liveLockScreenStyle: "combined",
            currencyCode: "USD",
            languageCode: "auto"
        )
    }
}

nonisolated extension TokenMonitorSharedPayload.Usage {
    private enum CodingKeys: String, CodingKey {
        case tokens, cost, cacheReadTokens, outputTokens, tools, models
        case tokensKnown, costKnown, tokenComponentsKnown, throughputKnown, unclassifiedTokens
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            tokens: try values.decodeIfPresent(Double.self, forKey: .tokens) ?? .nan,
            cost: try values.decodeIfPresent(Double.self, forKey: .cost) ?? .nan,
            cacheReadTokens: try values.decodeIfPresent(Double.self, forKey: .cacheReadTokens) ?? .nan,
            outputTokens: try values.decodeIfPresent(Double.self, forKey: .outputTokens) ?? .nan,
            tools: try values.decodeIfPresent([TokenMonitorSharedPayload.Breakdown].self, forKey: .tools) ?? [],
            models: try values.decodeIfPresent([TokenMonitorSharedPayload.Breakdown].self, forKey: .models) ?? [],
            tokensKnown: try values.decodeIfPresent(Bool.self, forKey: .tokensKnown),
            costKnown: try values.decodeIfPresent(Bool.self, forKey: .costKnown),
            tokenComponentsKnown: try values.decodeIfPresent(Bool.self, forKey: .tokenComponentsKnown),
            throughputKnown: try values.decodeIfPresent(Bool.self, forKey: .throughputKnown),
            unclassifiedTokens: try values.decodeIfPresent(Double.self, forKey: .unclassifiedTokens)
        )
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        // JSON has no NaN. Omission is the portable unknown representation.
        try values.encodeIfPresent(tokens.isFinite ? tokens : nil, forKey: .tokens)
        try values.encodeIfPresent(cost.isFinite ? cost : nil, forKey: .cost)
        try values.encodeIfPresent(cacheReadTokens.isFinite ? cacheReadTokens : nil, forKey: .cacheReadTokens)
        try values.encodeIfPresent(outputTokens.isFinite ? outputTokens : nil, forKey: .outputTokens)
        try values.encode(tools, forKey: .tools)
        try values.encode(models, forKey: .models)
        try values.encodeIfPresent(tokensKnown, forKey: .tokensKnown)
        try values.encodeIfPresent(costKnown, forKey: .costKnown)
        try values.encodeIfPresent(tokenComponentsKnown, forKey: .tokenComponentsKnown)
        try values.encodeIfPresent(throughputKnown, forKey: .throughputKnown)
        try values.encodeIfPresent(unclassifiedTokens, forKey: .unclassifiedTokens)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        func equal(_ left: Double, _ right: Double) -> Bool {
            left == right || (left.isNaN && right.isNaN)
        }
        return equal(lhs.tokens, rhs.tokens) && equal(lhs.cost, rhs.cost)
            && equal(lhs.cacheReadTokens, rhs.cacheReadTokens) && equal(lhs.outputTokens, rhs.outputTokens)
            && lhs.tools == rhs.tools && lhs.models == rhs.models
            && lhs.tokensKnown == rhs.tokensKnown && lhs.costKnown == rhs.costKnown
            && lhs.tokenComponentsKnown == rhs.tokenComponentsKnown && lhs.throughputKnown == rhs.throughputKnown
            && lhs.unclassifiedTokens == rhs.unclassifiedTokens
    }
}

nonisolated extension TokenMonitorSharedPayload.Day {
    private enum CodingKeys: String, CodingKey { case date, tokens, cost }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(date: try values.decode(String.self, forKey: .date),
            tokens: try values.decodeIfPresent(Double.self, forKey: .tokens) ?? .nan,
            cost: try values.decodeIfPresent(Double.self, forKey: .cost) ?? .nan)
    }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(date, forKey: .date)
        try values.encodeIfPresent(tokens.isFinite ? tokens : nil, forKey: .tokens)
        try values.encodeIfPresent(cost.isFinite ? cost : nil, forKey: .cost)
    }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.date == rhs.date && (lhs.tokens == rhs.tokens || (lhs.tokens.isNaN && rhs.tokens.isNaN))
            && (lhs.cost == rhs.cost || (lhs.cost.isNaN && rhs.cost.isNaN))
    }
}
