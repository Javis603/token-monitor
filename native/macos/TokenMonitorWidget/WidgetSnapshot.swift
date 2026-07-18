import Foundation

struct WidgetSnapshot: Decodable, Equatable {
    let schemaVersion: Int
    let generatedAt: Date
    let overview: WidgetOverview
    let quota: [WidgetQuotaProvider]
    let models: [WidgetModel]
    let activity: WidgetActivity
    let trend: WidgetTrend
    let periods: [WidgetPeriod: WidgetPeriodSnapshot]
    let presentation: WidgetPresentation
    let status: WidgetStatus

    var isEmpty: Bool { status.noData }

    func isStale(at date: Date, threshold: TimeInterval = 20 * 60) -> Bool {
        status.isStale || date.timeIntervalSince(generatedAt) > threshold
    }

    static func load(appGroup: String) -> WidgetSnapshot? {
        guard !appGroup.isEmpty,
              let container = FileManager.default.containerURL(
                forSecurityApplicationGroupIdentifier: appGroup
              ) else { return nil }
        return load(from: container.appendingPathComponent("snapshot.json"))
    }

    static func load(from url: URL) -> WidgetSnapshot? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(WidgetSnapshot.self, from: data)
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion, generatedAt, periods, overview, quota, models, activity, trend, presentation, status
        case today, tools, limits
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
        generatedAt = try container.decode(Date.self, forKey: .generatedAt)
        if schemaVersion >= 2 {
            let decodedPeriods = (try? container.decodeIfPresent([String: WidgetPeriodSnapshot].self, forKey: .periods)) ?? [:]
            periods = Dictionary(uniqueKeysWithValues: decodedPeriods.compactMap { key, value in
                guard let period = WidgetPeriod(rawValue: key) else { return nil }
                return (period, value)
            })
            let fallbackOverview = try container.decodeIfPresent(WidgetOverview.self, forKey: .overview) ?? .empty(generatedAt: generatedAt)
            let fallbackModels = try container.decodeIfPresent([WidgetModel].self, forKey: .models) ?? []
            let fallbackActivity = try container.decodeIfPresent(WidgetActivity.self, forKey: .activity) ?? .empty
            let fallbackTrend = try container.decodeIfPresent(WidgetTrend.self, forKey: .trend) ?? .empty
            let initialPeriod = periods[.day] ?? WidgetPeriodSnapshot(
                overview: fallbackOverview,
                models: fallbackModels,
                activity: fallbackActivity,
                trend: fallbackTrend
            )
            overview = initialPeriod.overview
            models = initialPeriod.models
            activity = initialPeriod.activity
            trend = initialPeriod.trend
            quota = try container.decodeIfPresent([WidgetQuotaProvider].self, forKey: .quota) ?? []
            presentation = try container.decodeIfPresent(WidgetPresentation.self, forKey: .presentation) ?? .default
            status = try container.decodeIfPresent(WidgetStatus.self, forKey: .status)
                ?? WidgetStatus(isStale: false, dataAgeSeconds: 0, providerConfigured: !quota.isEmpty, providerNeedsLogin: false, noData: overview.totalTokens == 0 && models.isEmpty && activity.activeDays == 0)
        } else {
            let today = try container.decodeIfPresent(LegacyToday.self, forKey: .today) ?? .empty
            let limits = try container.decodeIfPresent([WidgetQuotaProvider].self, forKey: .limits) ?? []
            overview = WidgetOverview(currentPeriod: "today", totalTokens: today.totalTokens, costUsd: today.costUsd, primaryTool: nil, updatedAt: generatedAt)
            quota = limits
            models = []
            activity = .empty
            trend = .empty
            periods = [:]
            presentation = .default
            status = WidgetStatus(isStale: false, dataAgeSeconds: 0, providerConfigured: !limits.isEmpty, providerNeedsLogin: limits.contains { $0.status == "unauthorized" }, noData: today.totalTokens == 0 && today.costUsd == 0 && limits.isEmpty)
        }
    }

    init(schemaVersion: Int, generatedAt: Date, overview: WidgetOverview, quota: [WidgetQuotaProvider], models: [WidgetModel], activity: WidgetActivity, trend: WidgetTrend, periods: [WidgetPeriod: WidgetPeriodSnapshot] = [:], presentation: WidgetPresentation, status: WidgetStatus) {
        self.schemaVersion = schemaVersion
        self.generatedAt = generatedAt
        self.overview = overview
        self.quota = quota
        self.models = models
        self.activity = activity
        self.trend = trend
        self.periods = periods
        self.presentation = presentation
        self.status = status
    }

    func selecting(_ period: WidgetPeriod) -> WidgetSnapshot {
        guard let selected = periods[period] else {
            if period == .day { return self }
            return WidgetSnapshot(
                schemaVersion: schemaVersion,
                generatedAt: generatedAt,
                overview: WidgetOverview(currentPeriod: period.title.lowercased(), totalTokens: 0, costUsd: 0, primaryTool: nil, updatedAt: generatedAt),
                quota: quota,
                models: [],
                activity: WidgetActivity(currentPeriod: period.title.lowercased(), activeDays: 0, days: []),
                trend: .empty,
                periods: periods,
                presentation: presentation,
                status: WidgetStatus(isStale: status.isStale, dataAgeSeconds: status.dataAgeSeconds, providerConfigured: status.providerConfigured, providerNeedsLogin: status.providerNeedsLogin, noData: true)
            )
        }
        return WidgetSnapshot(
            schemaVersion: schemaVersion,
            generatedAt: generatedAt,
            overview: selected.overview,
            quota: quota,
            models: selected.models,
            activity: selected.activity,
            trend: selected.trend,
            periods: periods,
            presentation: presentation,
            status: WidgetStatus(
                isStale: status.isStale,
                dataAgeSeconds: status.dataAgeSeconds,
                providerConfigured: status.providerConfigured,
                providerNeedsLogin: status.providerNeedsLogin,
                noData: selected.overview.totalTokens == 0 && selected.models.isEmpty && selected.activity.activeDays == 0
            )
        )
    }

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            if let date = fractionalDateFormatter.date(from: value) ?? basicDateFormatter.date(from: value) { return date }
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "Expected an ISO-8601 timestamp")
        }
        return decoder
    }()

    private static let fractionalDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let basicDateFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

struct WidgetPeriodSnapshot: Decodable, Equatable {
    let overview: WidgetOverview
    let models: [WidgetModel]
    let activity: WidgetActivity
    let trend: WidgetTrend

    private enum CodingKeys: String, CodingKey { case overview, models, activity, trend }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        overview = try c.decodeIfPresent(WidgetOverview.self, forKey: .overview) ?? .empty(generatedAt: .distantPast)
        models = try c.decodeIfPresent([WidgetModel].self, forKey: .models) ?? []
        activity = try c.decodeIfPresent(WidgetActivity.self, forKey: .activity) ?? .empty
        trend = try c.decodeIfPresent(WidgetTrend.self, forKey: .trend) ?? .empty
    }

    init(overview: WidgetOverview, models: [WidgetModel], activity: WidgetActivity, trend: WidgetTrend) {
        self.overview = overview
        self.models = models
        self.activity = activity
        self.trend = trend
    }
}

struct WidgetOverview: Decodable, Equatable {
    let currentPeriod: String
    let totalTokens: Int
    let costUsd: Double
    let primaryTool: String?
    let updatedAt: Date

    static func empty(generatedAt: Date) -> WidgetOverview {
        WidgetOverview(currentPeriod: "today", totalTokens: 0, costUsd: 0, primaryTool: nil, updatedAt: generatedAt)
    }
}

private struct LegacyToday: Decodable {
    let totalTokens: Int
    let costUsd: Double
    static let empty = LegacyToday(totalTokens: 0, costUsd: 0)
}

struct WidgetQuotaProvider: Decodable, Equatable, Identifiable {
    let provider: String
    let status: String
    let updatedAt: Date?
    let balance: WidgetQuotaBalance?
    let windows: [WidgetLimitWindow]
    var id: String { "\(provider)-\(updatedAt?.timeIntervalSince1970 ?? 0)" }

    var displayStatus: String {
        switch status {
        case "ok": WidgetL10n.text("Available")
        case "disabled": WidgetL10n.text("Disabled")
        case "notConfigured": WidgetL10n.text("Not configured")
        case "unauthorized", "sessionExpired": WidgetL10n.text("Sign in again")
        case "rateLimited", "sourceRateLimited": WidgetL10n.text("Rate limited")
        case "unavailable": WidgetL10n.text("Unavailable")
        case "stale": WidgetL10n.text("Data may be stale")
        default: WidgetL10n.text("Temporarily unavailable")
        }
    }

    private enum CodingKeys: String, CodingKey { case provider, status, updatedAt, balance, windows }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? "unknown"
        status = try container.decodeIfPresent(String.self, forKey: .status) ?? "unavailable"
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt)
        balance = try container.decodeIfPresent(WidgetQuotaBalance.self, forKey: .balance)
        windows = try container.decodeIfPresent([WidgetLimitWindow].self, forKey: .windows) ?? []
    }

    init(provider: String, status: String, updatedAt: Date?, windows: [WidgetLimitWindow], balance: WidgetQuotaBalance? = nil) {
        self.provider = provider
        self.status = status
        self.updatedAt = updatedAt
        self.balance = balance
        self.windows = windows
    }
}

struct WidgetQuotaBalance: Decodable, Equatable {
    let amount: Double
    let currency: String
}

struct WidgetLimitWindow: Decodable, Equatable, Identifiable {
    let kind: String
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetsAt: Date?
    let windowMinutes: Double?
    var id: String { kind }
}

struct WidgetModel: Decodable, Equatable, Identifiable {
    let displayName: String
    let totalTokens: Int
    let costUsd: Double
    let sharePercent: Double
    var id: String { displayName }
}

struct WidgetActivityDay: Decodable, Equatable, Identifiable {
    let date: String
    let intensity: Int
    let totalTokens: Int
    var id: String { date }

    init(date: String, intensity: Int, totalTokens: Int = 0) {
        self.date = date
        self.intensity = intensity
        self.totalTokens = max(0, totalTokens)
    }
}

struct WidgetActivity: Decodable, Equatable {
    let currentPeriod: String
    let activeDays: Int
    let days: [WidgetActivityDay]
    static let empty = WidgetActivity(currentPeriod: "today", activeDays: 0, days: [])
}

struct WidgetTrendPoint: Decodable, Equatable, Identifiable {
    let date: String
    let totalTokens: Int
    let costUsd: Double
    var id: String { date }
}

struct WidgetTrend: Decodable, Equatable {
    let startDate: String?
    let endDate: String?
    let peakTokens: Int
    let currentTokens: Int
    let points: [WidgetTrendPoint]
    static let empty = WidgetTrend(startDate: nil, endDate: nil, peakTokens: 0, currentTokens: 0, points: [])
}

struct WidgetPresentation: Decodable, Equatable {
    let defaultPeriod: String
    let currencyCode: String
    let currencySymbol: String
    let currencyRate: Double
    let numberStyle: String
    let showCost: Bool
    let locale: String
    let theme: String
    static let `default` = WidgetPresentation(defaultPeriod: "today", currencyCode: "USD", currencySymbol: "$", currencyRate: 1, numberStyle: "compact", showCost: true, locale: "auto", theme: "system")
}

struct WidgetStatus: Decodable, Equatable {
    let isStale: Bool
    let dataAgeSeconds: Int
    let providerConfigured: Bool
    let providerNeedsLogin: Bool
    let noData: Bool
}

private extension KeyedDecodingContainer {
    func string(_ key: Key, default fallback: String = "") -> String { (try? decodeIfPresent(String.self, forKey: key)) ?? fallback }
    func int(_ key: Key, default fallback: Int = 0) -> Int { (try? decodeIfPresent(Int.self, forKey: key)) ?? fallback }
    func double(_ key: Key, default fallback: Double = 0) -> Double { (try? decodeIfPresent(Double.self, forKey: key)) ?? fallback }
    func bool(_ key: Key, default fallback: Bool = false) -> Bool { (try? decodeIfPresent(Bool.self, forKey: key)) ?? fallback }
}

extension WidgetOverview {
    private enum CodingKeys: String, CodingKey { case currentPeriod, totalTokens, costUsd, primaryTool, updatedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currentPeriod = c.string(.currentPeriod, default: "today")
        totalTokens = c.int(.totalTokens)
        costUsd = c.double(.costUsd)
        primaryTool = try? c.decodeIfPresent(String.self, forKey: .primaryTool)
        updatedAt = (try? c.decodeIfPresent(Date.self, forKey: .updatedAt)) ?? .distantPast
    }
}

extension WidgetLimitWindow {
    private enum CodingKeys: String, CodingKey { case kind, usedPercent, remainingPercent, resetsAt, windowMinutes }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.string(.kind)
        usedPercent = try? c.decodeIfPresent(Double.self, forKey: .usedPercent)
        remainingPercent = try? c.decodeIfPresent(Double.self, forKey: .remainingPercent)
        resetsAt = try? c.decodeIfPresent(Date.self, forKey: .resetsAt)
        windowMinutes = try? c.decodeIfPresent(Double.self, forKey: .windowMinutes)
    }
}

extension WidgetModel {
    private enum CodingKeys: String, CodingKey { case displayName, totalTokens, costUsd, sharePercent }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        displayName = c.string(.displayName)
        totalTokens = c.int(.totalTokens)
        costUsd = c.double(.costUsd)
        sharePercent = c.double(.sharePercent)
    }
}

extension WidgetActivityDay {
    private enum CodingKeys: String, CodingKey { case date, intensity, totalTokens }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = c.string(.date)
        intensity = c.int(.intensity)
        totalTokens = max(0, c.int(.totalTokens))
    }
}

extension WidgetActivity {
    private enum CodingKeys: String, CodingKey { case currentPeriod, activeDays, days }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currentPeriod = c.string(.currentPeriod, default: "today")
        activeDays = c.int(.activeDays)
        days = (try? c.decodeIfPresent([WidgetActivityDay].self, forKey: .days)) ?? []
    }
}

extension WidgetTrendPoint {
    private enum CodingKeys: String, CodingKey { case date, totalTokens, costUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = c.string(.date)
        totalTokens = c.int(.totalTokens)
        costUsd = c.double(.costUsd)
    }
}

extension WidgetTrend {
    private enum CodingKeys: String, CodingKey { case startDate, endDate, peakTokens, currentTokens, points }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        startDate = try? c.decodeIfPresent(String.self, forKey: .startDate)
        endDate = try? c.decodeIfPresent(String.self, forKey: .endDate)
        peakTokens = c.int(.peakTokens)
        currentTokens = c.int(.currentTokens)
        points = (try? c.decodeIfPresent([WidgetTrendPoint].self, forKey: .points)) ?? []
    }
}

extension WidgetPresentation {
    private enum CodingKeys: String, CodingKey { case defaultPeriod, currencyCode, currencySymbol, currencyRate, numberStyle, showCost, locale, theme }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        defaultPeriod = c.string(.defaultPeriod, default: "today")
        currencyCode = c.string(.currencyCode, default: "USD")
        currencySymbol = c.string(.currencySymbol, default: "$")
        currencyRate = c.double(.currencyRate, default: 1)
        numberStyle = c.string(.numberStyle, default: "compact")
        showCost = c.bool(.showCost, default: true)
        locale = c.string(.locale, default: "auto")
        theme = c.string(.theme, default: "system")
    }
}

extension WidgetStatus {
    private enum CodingKeys: String, CodingKey { case isStale, dataAgeSeconds, providerConfigured, providerNeedsLogin, noData }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isStale = c.bool(.isStale)
        dataAgeSeconds = c.int(.dataAgeSeconds)
        providerConfigured = c.bool(.providerConfigured)
        providerNeedsLogin = c.bool(.providerNeedsLogin)
        noData = c.bool(.noData)
    }
}
