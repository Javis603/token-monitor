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
            let fallbackModels = normalizeWidgetModels(try container.decodeIfPresent([WidgetModel].self, forKey: .models) ?? [])
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
            let decodedQuota = (try? container.decodeIfPresent(WidgetQuotaProviderArray.self, forKey: .quota)) ?? nil
            quota = normalizeQuotaProviders(decodedQuota?.values ?? [])
            presentation = try container.decodeIfPresent(WidgetPresentation.self, forKey: .presentation) ?? .default
            status = try container.decodeIfPresent(WidgetStatus.self, forKey: .status)
                ?? WidgetStatus(isStale: false, sourceUpdatedAt: nil, dataAgeSeconds: 0, providerConfigured: !quota.isEmpty, providerNeedsLogin: false, noData: overview.totalTokens == 0 && models.isEmpty && activity.activeDays == 0)
        } else {
            let today = try container.decodeIfPresent(LegacyToday.self, forKey: .today) ?? .empty
            let decodedLimits = (try? container.decodeIfPresent(WidgetQuotaProviderArray.self, forKey: .limits)) ?? nil
            let limits = decodedLimits?.values ?? []
            overview = WidgetOverview(currentPeriod: "today", totalTokens: today.totalTokens, costUsd: today.costUsd, primaryTool: nil, updatedAt: generatedAt)
            quota = normalizeQuotaProviders(limits)
            models = []
            activity = .empty
            trend = .empty
            periods = [:]
            presentation = .default
            status = WidgetStatus(isStale: false, sourceUpdatedAt: nil, dataAgeSeconds: 0, providerConfigured: !limits.isEmpty, providerNeedsLogin: limits.contains { $0.status == "unauthorized" }, noData: today.totalTokens == 0 && today.costUsd == 0 && limits.isEmpty)
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
                status: WidgetStatus(isStale: status.isStale, sourceStale: status.sourceStale, sourceUpdatedAt: status.sourceUpdatedAt, dataAgeSeconds: status.dataAgeSeconds, providerConfigured: status.providerConfigured, providerNeedsLogin: status.providerNeedsLogin, noData: true)
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
                sourceStale: status.sourceStale,
                sourceUpdatedAt: status.sourceUpdatedAt,
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
        models = normalizeWidgetModels(try c.decodeIfPresent([WidgetModel].self, forKey: .models) ?? [])
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
    let instanceId: String
    let displayName: String?
    let provider: String
    let status: String
    let updatedAt: Date?
    let balance: WidgetQuotaBalance?
    let windows: [WidgetLimitWindow]
    var id: String { instanceId }

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

    private enum CodingKeys: String, CodingKey { case instanceId, displayName, provider, status, updatedAt, balance, windows }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let decodedProvider = container.optionalString(.provider), !decodedProvider.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .provider, in: container, debugDescription: "Widget quota provider is missing an identifier")
        }
        provider = decodedProvider
        status = container.string(.status, default: "unavailable")
        updatedAt = try? container.decodeIfPresent(Date.self, forKey: .updatedAt)
        balance = try? container.decodeIfPresent(WidgetQuotaBalance.self, forKey: .balance)
        windows = (try? container.decodeIfPresent([WidgetLimitWindow].self, forKey: .windows)) ?? []
        let decodedInstanceId = container.string(.instanceId)
        instanceId = decodedInstanceId.isEmpty
            ? widgetQuotaFallbackID(provider: provider)
            : decodedInstanceId
        displayName = container.optionalString(.displayName)
    }

    init(provider: String, status: String, updatedAt: Date?, windows: [WidgetLimitWindow], balance: WidgetQuotaBalance? = nil, instanceId: String? = nil, displayName: String? = nil) {
        self.instanceId = instanceId ?? widgetQuotaFallbackID(provider: provider)
        self.displayName = displayName
        self.provider = provider
        self.status = status
        self.updatedAt = updatedAt
        self.balance = balance
        self.windows = windows
    }

    func withInstanceId(_ value: String) -> WidgetQuotaProvider {
        WidgetQuotaProvider(provider: provider, status: status, updatedAt: updatedAt, windows: windows, balance: balance, instanceId: value, displayName: displayName)
    }
}

struct WidgetQuotaBalance: Decodable, Equatable {
    let amount: Double
    let currency: String
}

struct WidgetLimitWindow: Decodable, Equatable, Identifiable {
    let kind: String
    let metric: String?
    let showMeter: Bool
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetsAt: Date?
    let windowMinutes: Double?
    let remaining: Double?
    let currency: String?
    var id: String { kind }

    init(
        kind: String,
        usedPercent: Double?,
        remainingPercent: Double?,
        resetsAt: Date?,
        windowMinutes: Double?,
        metric: String? = nil,
        showMeter: Bool = true,
        remaining: Double? = nil,
        currency: String? = nil
    ) {
        self.kind = kind
        self.metric = metric
        self.showMeter = showMeter
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
        self.resetsAt = resetsAt
        self.windowMinutes = windowMinutes
        self.remaining = remaining
        self.currency = currency
    }
}

struct WidgetModel: Decodable, Equatable, Identifiable {
    let modelId: String
    let displayName: String
    let totalTokens: Int
    let costUsd: Double
    let sharePercent: Double
    var id: String { modelId }

    init(displayName: String, totalTokens: Int, costUsd: Double, sharePercent: Double, id: String? = nil) {
        self.displayName = displayName
        self.totalTokens = totalTokens
        self.costUsd = costUsd
        self.sharePercent = sharePercent
        self.modelId = id ?? "model-\(stableWidgetHash("\(displayName)|\(totalTokens)|\(costUsd)|\(sharePercent)"))"
    }

    func withModelId(_ value: String) -> WidgetModel {
        WidgetModel(displayName: displayName, totalTokens: totalTokens, costUsd: costUsd, sharePercent: sharePercent, id: value)
    }
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
    let currencyCode: String
    let currencySymbol: String
    let currencyRate: Double
    let numberStyle: String
    let compactTokenUnits: String
    let showCost: Bool
    let locale: String
    let theme: String
    static let `default` = WidgetPresentation(currencyCode: "USD", currencySymbol: "$", currencyRate: 1, numberStyle: "compact", compactTokenUnits: "western", showCost: true, locale: "auto", theme: "system")
}

struct WidgetStatus: Decodable, Equatable {
    let isStale: Bool
    let sourceStale: Bool
    let sourceUpdatedAt: Date?
    let dataAgeSeconds: Int
    let providerConfigured: Bool
    let providerNeedsLogin: Bool
    let noData: Bool

    init(isStale: Bool, sourceStale: Bool = false, sourceUpdatedAt: Date? = nil, dataAgeSeconds: Int, providerConfigured: Bool, providerNeedsLogin: Bool, noData: Bool) {
        self.isStale = isStale
        self.sourceStale = sourceStale
        self.sourceUpdatedAt = sourceUpdatedAt
        self.dataAgeSeconds = dataAgeSeconds
        self.providerConfigured = providerConfigured
        self.providerNeedsLogin = providerNeedsLogin
        self.noData = noData
    }
}

enum WidgetStalePresentation {
    static func trustedUpdatedAt(for snapshot: WidgetSnapshot) -> Date? {
        if let sourceUpdatedAt = snapshot.status.sourceUpdatedAt {
            return sourceUpdatedAt
        }
        if snapshot.status.dataAgeSeconds > 0 {
            return snapshot.generatedAt.addingTimeInterval(-TimeInterval(snapshot.status.dataAgeSeconds))
        }
        let overviewUpdatedAt = snapshot.overview.updatedAt
        guard overviewUpdatedAt.timeIntervalSince1970 > 0,
              snapshot.generatedAt.timeIntervalSince(overviewUpdatedAt) > 1 else {
            return nil
        }
        return overviewUpdatedAt
    }
}

private struct WidgetAnyCodingKey: CodingKey {
    let stringValue: String
    init?(stringValue: String) { self.stringValue = stringValue }
    let intValue: Int? = nil
    init?(intValue: Int) { return nil }
}

private struct WidgetDiscardedValue: Decodable {
    init(from decoder: Decoder) throws {
        if var container = try? decoder.unkeyedContainer() {
            while !container.isAtEnd {
                _ = try container.decode(WidgetDiscardedValue.self)
            }
            return
        }
        if let container = try? decoder.container(keyedBy: WidgetAnyCodingKey.self) {
            for key in container.allKeys {
                _ = try container.decode(WidgetDiscardedValue.self, forKey: key)
            }
            return
        }
        _ = try decoder.singleValueContainer()
    }
}

private struct WidgetQuotaProviderArray: Decodable {
    let values: [WidgetQuotaProvider]

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var decoded: [WidgetQuotaProvider] = []
        while !container.isAtEnd {
            do {
                decoded.append(try container.decode(WidgetQuotaProvider.self))
            } catch {
                _ = try container.decode(WidgetDiscardedValue.self)
            }
        }
        values = decoded
    }
}

private func stableWidgetHash(_ value: String) -> String {
    var hash: UInt64 = 0xcbf29ce484222325
    for byte in value.utf8 {
        hash ^= UInt64(byte)
        hash &*= 0x100000001b3
    }
    let value = String(hash, radix: 16)
    return String(repeating: "0", count: max(0, 12 - value.count)) + value
}

private func widgetQuotaFallbackID(provider: String) -> String {
    "\(provider)-single"
}

private func normalizeQuotaProviders(_ providers: [WidgetQuotaProvider]) -> [WidgetQuotaProvider] {
    var seen: [String: Int] = [:]
    return providers.map { provider in
        let occurrence = (seen[provider.instanceId] ?? 0) + 1
        seen[provider.instanceId] = occurrence
        guard occurrence > 1 else { return provider }
        return provider.withInstanceId("\(provider.instanceId)-\(occurrence)")
    }
}

private func normalizeWidgetModels(_ models: [WidgetModel]) -> [WidgetModel] {
    var seen: [String: Int] = [:]
    return models.map { model in
        let occurrence = (seen[model.modelId] ?? 0) + 1
        seen[model.modelId] = occurrence
        guard occurrence > 1 else { return model }
        return model.withModelId("\(model.modelId)-\(occurrence)")
    }
}

private extension KeyedDecodingContainer {
    func string(_ key: Key, default fallback: String = "") -> String { (try? decodeIfPresent(String.self, forKey: key)) ?? fallback }
    func optionalString(_ key: Key) -> String? { try? decodeIfPresent(String.self, forKey: key) }
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
    private enum CodingKeys: String, CodingKey { case kind, metric, showMeter, usedPercent, remainingPercent, resetsAt, windowMinutes, remaining, currency }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = c.string(.kind)
        let rawMetric = c.string(.metric).lowercased()
        metric = ["credits", "spend"].contains(rawMetric) ? rawMetric : nil
        showMeter = c.bool(.showMeter, default: true)
        usedPercent = try? c.decodeIfPresent(Double.self, forKey: .usedPercent)
        remainingPercent = try? c.decodeIfPresent(Double.self, forKey: .remainingPercent)
        resetsAt = try? c.decodeIfPresent(Date.self, forKey: .resetsAt)
        windowMinutes = try? c.decodeIfPresent(Double.self, forKey: .windowMinutes)
        remaining = try? c.decodeIfPresent(Double.self, forKey: .remaining)
        currency = try? c.decodeIfPresent(String.self, forKey: .currency)
    }
}

extension WidgetModel {
    private enum CodingKeys: String, CodingKey { case id, displayName, totalTokens, costUsd, sharePercent }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        displayName = c.string(.displayName)
        totalTokens = c.int(.totalTokens)
        costUsd = c.double(.costUsd)
        sharePercent = c.double(.sharePercent)
        let decodedID = c.string(.id)
        modelId = decodedID.isEmpty
            ? "model-\(stableWidgetHash("\(displayName)|\(totalTokens)|\(costUsd)|\(sharePercent)"))"
            : decodedID
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
    private enum CodingKeys: String, CodingKey { case currencyCode, currencySymbol, currencyRate, numberStyle, compactTokenUnits, showCost, locale, theme }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currencyCode = c.string(.currencyCode, default: "USD")
        currencySymbol = c.string(.currencySymbol, default: "$")
        currencyRate = c.double(.currencyRate, default: 1)
        numberStyle = c.string(.numberStyle, default: "compact")
        compactTokenUnits = c.string(.compactTokenUnits, default: "western")
        showCost = c.bool(.showCost, default: true)
        locale = c.string(.locale, default: "auto")
        theme = c.string(.theme, default: "system")
    }
}

extension WidgetStatus {
    private enum CodingKeys: String, CodingKey { case isStale, sourceStale, sourceUpdatedAt, dataAgeSeconds, providerConfigured, providerNeedsLogin, noData }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isStale = c.bool(.isStale)
        sourceStale = c.bool(.sourceStale, default: false)
        sourceUpdatedAt = try? c.decodeIfPresent(Date.self, forKey: .sourceUpdatedAt)
        dataAgeSeconds = c.int(.dataAgeSeconds)
        providerConfigured = c.bool(.providerConfigured)
        providerNeedsLogin = c.bool(.providerNeedsLogin)
        noData = c.bool(.noData)
    }
}

// The sample snapshot the widget gallery and the loading state render.
// It lives with the model rather than the timeline provider so the test
// target, which compiles the model but not the provider, can reach it.
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
        schemaVersion: 6,
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
