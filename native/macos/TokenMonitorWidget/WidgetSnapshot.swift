import Foundation

struct WidgetSnapshot: Decodable, Equatable {
    static let currentSchemaVersion = 10

    let schemaVersion: Int
    let generatedAt: Date
    let quota: [WidgetQuotaProvider]
    let periods: [WidgetPeriod: WidgetPeriodSnapshot]
    let presentation: WidgetPresentation
    let status: WidgetStatus
    private let selectedPeriod: WidgetPeriod

    var overview: WidgetOverview { selectedSnapshot.overview }
    var tools: [WidgetTool] { selectedSnapshot.tools }
    var models: [WidgetModel] { selectedSnapshot.models }
    var activity: WidgetActivity { selectedSnapshot.activity }
    var trend: WidgetTrend { selectedSnapshot.trend }
    var isEmpty: Bool {
        overview.totalTokens == 0 && models.isEmpty && activity.activeDays == 0
    }

    private var selectedSnapshot: WidgetPeriodSnapshot {
        // Decoding and the memberwise initializer both enforce the complete
        // current-schema period set, so selection never fabricates data.
        periods[selectedPeriod]!
    }

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
        case schemaVersion, generatedAt, periods, quota, presentation, status
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        guard schemaVersion == Self.currentSchemaVersion else {
            throw DecodingError.dataCorruptedError(
                forKey: .schemaVersion,
                in: container,
                debugDescription: "Unsupported Widget snapshot schema"
            )
        }
        generatedAt = try container.decode(Date.self, forKey: .generatedAt)
        let decodedPeriods = try container.decode([String: WidgetPeriodSnapshot].self, forKey: .periods)
        let periodsByKind: [WidgetPeriod: WidgetPeriodSnapshot] = Dictionary(uniqueKeysWithValues: decodedPeriods.compactMap { key, value in
            guard let period = WidgetPeriod(rawValue: key) else { return nil }
            return (period, value)
        })
        let missingPeriods = WidgetPeriod.allCases.filter { periodsByKind[$0] == nil }
        guard missingPeriods.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .periods,
                in: container,
                debugDescription: "Widget snapshot is missing current-schema periods: \(missingPeriods.map { $0.rawValue }.joined(separator: ", "))"
            )
        }
        periods = periodsByKind
        quota = try container.decode(WidgetQuotaProviderArray.self, forKey: .quota).values
        presentation = try container.decode(WidgetPresentation.self, forKey: .presentation)
        status = try container.decode(WidgetStatus.self, forKey: .status)
        selectedPeriod = .day
    }

    init(schemaVersion: Int, generatedAt: Date, quota: [WidgetQuotaProvider], periods: [WidgetPeriod: WidgetPeriodSnapshot], presentation: WidgetPresentation, status: WidgetStatus, selectedPeriod: WidgetPeriod = .day) {
        precondition(WidgetPeriod.allCases.allSatisfy { periods[$0] != nil })
        self.schemaVersion = schemaVersion
        self.generatedAt = generatedAt
        self.quota = quota
        self.periods = periods
        self.presentation = presentation
        self.status = status
        self.selectedPeriod = selectedPeriod
    }

    func selecting(_ period: WidgetPeriod) -> WidgetSnapshot {
        WidgetSnapshot(
            schemaVersion: schemaVersion,
            generatedAt: generatedAt,
            quota: quota,
            periods: periods,
            presentation: presentation,
            status: status,
            selectedPeriod: period
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
    let tools: [WidgetTool]
    let models: [WidgetModel]
    let activity: WidgetActivity
    let trend: WidgetTrend

    private enum CodingKeys: String, CodingKey { case overview, tools, models, activity, trend }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        overview = try c.decode(WidgetOverview.self, forKey: .overview)
        tools = try c.decode([WidgetTool].self, forKey: .tools)
        models = try c.decode([WidgetModel].self, forKey: .models)
        activity = try c.decode(WidgetActivity.self, forKey: .activity)
        trend = try c.decode(WidgetTrend.self, forKey: .trend)
    }

    init(overview: WidgetOverview, tools: [WidgetTool] = [], models: [WidgetModel], activity: WidgetActivity, trend: WidgetTrend) {
        self.overview = overview
        self.tools = tools
        self.models = models
        self.activity = activity
        self.trend = trend
    }
}

struct WidgetOverview: Decodable, Equatable {
    let totalTokens: Int
    let costUsd: Double
}

struct WidgetQuotaProvider: Decodable, Equatable, Identifiable {
    let instanceId: String
    let displayName: String?
    let accountLabel: String?
    let isCurrentAccount: Bool
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

    private enum CodingKeys: String, CodingKey { case instanceId, displayName, accountLabel, isCurrentAccount, provider, status, updatedAt, balance, windows }
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let decodedProvider = container.optionalString(.provider), !decodedProvider.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .provider, in: container, debugDescription: "Widget quota provider is missing an identifier")
        }
        provider = decodedProvider
        status = try container.decode(String.self, forKey: .status)
        updatedAt = try? container.decodeIfPresent(Date.self, forKey: .updatedAt)
        balance = try? container.decodeIfPresent(WidgetQuotaBalance.self, forKey: .balance)
        windows = try container.decode([WidgetLimitWindow].self, forKey: .windows)
        let decodedInstanceId = try container.decode(String.self, forKey: .instanceId)
        guard !decodedInstanceId.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .instanceId,
                in: container,
                debugDescription: "Widget quota provider is missing its current-schema instance identifier"
            )
        }
        instanceId = decodedInstanceId
        displayName = container.optionalString(.displayName)
        accountLabel = container.optionalString(.accountLabel)
        isCurrentAccount = (try? container.decodeIfPresent(Bool.self, forKey: .isCurrentAccount)) ?? false
    }

    init(instanceId: String, provider: String, status: String, updatedAt: Date?, windows: [WidgetLimitWindow], balance: WidgetQuotaBalance? = nil, displayName: String? = nil, accountLabel: String? = nil, isCurrentAccount: Bool = false) {
        self.instanceId = instanceId
        self.displayName = displayName
        self.accountLabel = accountLabel
        self.isCurrentAccount = isCurrentAccount
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
    let allTimeSpend: Double?

    init(amount: Double, currency: String, allTimeSpend: Double? = nil) {
        self.amount = amount
        self.currency = currency
        self.allTimeSpend = allTimeSpend
    }
}

struct WidgetLimitWindow: Decodable, Equatable, Identifiable {
    let kind: String
    let label: String?
    let metric: String?
    let showMeter: Bool
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetsAt: Date?
    let boundaryKind: String?
    let windowMinutes: Double?
    let remaining: Double?
    let used: Double?
    let currency: String?
    let detail: String?
    var id: String { "\(kind)|\(label ?? "")" }

    init(
        kind: String,
        usedPercent: Double? = nil,
        remainingPercent: Double?,
        resetsAt: Date?,
        windowMinutes: Double? = nil,
        boundaryKind: String? = nil,
        metric: String? = nil,
        showMeter: Bool = true,
        remaining: Double? = nil,
        used: Double? = nil,
        currency: String? = nil,
        detail: String? = nil,
        label: String? = nil
    ) {
        self.kind = kind
        self.label = label
        self.metric = metric
        self.showMeter = showMeter
        self.usedPercent = usedPercent
        self.remainingPercent = remainingPercent
        self.resetsAt = resetsAt
        self.boundaryKind = boundaryKind
        self.windowMinutes = windowMinutes
        self.remaining = remaining
        self.used = used
        self.currency = currency
        self.detail = detail
    }
}

struct WidgetModel: Decodable, Equatable, Identifiable {
    let modelId: String
    let displayName: String
    let totalTokens: Int
    let costUsd: Double
    let sharePercent: Double
    var id: String { modelId }

    init(id: String, displayName: String, totalTokens: Int, costUsd: Double = 0, sharePercent: Double) {
        self.modelId = id
        self.displayName = displayName
        self.totalTokens = totalTokens
        self.costUsd = costUsd
        self.sharePercent = sharePercent
    }

}

struct WidgetTool: Decodable, Equatable, Identifiable {
    let id: String
    let totalTokens: Int
    let costUsd: Double
    let sharePercent: Double

    init(id: String, totalTokens: Int, costUsd: Double = 0, sharePercent: Double) {
        self.id = id
        self.totalTokens = totalTokens
        self.costUsd = costUsd
        self.sharePercent = sharePercent
    }
}

struct WidgetActivityDay: Decodable, Equatable, Identifiable {
    let date: String
    let intensity: Int
    let totalTokens: Int
    let costUsd: Double
    var id: String { date }

    init(date: String, intensity: Int, totalTokens: Int = 0, costUsd: Double = 0) {
        self.date = date
        self.intensity = intensity
        self.totalTokens = max(0, totalTokens)
        self.costUsd = max(0, costUsd)
    }
}

struct WidgetActivity: Decodable, Equatable {
    let activeDays: Int
    let days: [WidgetActivityDay]
}

struct WidgetTrendPoint: Decodable, Equatable, Identifiable {
    let date: String
    let totalTokens: Int
    let costUsd: Double
    var id: String { date }

    init(date: String, totalTokens: Int, costUsd: Double = 0) {
        self.date = date
        self.totalTokens = totalTokens
        self.costUsd = max(0, costUsd)
    }
}

struct WidgetTrend: Decodable, Equatable {
    let points: [WidgetTrendPoint]
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
    let sourceUpdatedAt: Date?
}

enum WidgetStalePresentation {
    static func trustedUpdatedAt(for snapshot: WidgetSnapshot) -> Date? {
        snapshot.status.sourceUpdatedAt
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

private extension KeyedDecodingContainer {
    func optionalString(_ key: Key) -> String? { try? decodeIfPresent(String.self, forKey: key) }
}

extension WidgetOverview {
    private enum CodingKeys: String, CodingKey { case totalTokens, costUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalTokens = try c.decode(Int.self, forKey: .totalTokens)
        costUsd = try c.decode(Double.self, forKey: .costUsd)
    }
}

extension WidgetLimitWindow {
    private enum CodingKeys: String, CodingKey { case kind, label, metric, showMeter, usedPercent, remainingPercent, resetsAt, boundaryKind, windowMinutes, remaining, used, currency, detail }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decode(String.self, forKey: .kind)
        label = c.optionalString(.label)
        let rawMetric = (try c.decodeIfPresent(String.self, forKey: .metric) ?? "").lowercased()
        metric = ["credits", "spend"].contains(rawMetric) ? rawMetric : nil
        showMeter = try c.decode(Bool.self, forKey: .showMeter)
        usedPercent = try? c.decodeIfPresent(Double.self, forKey: .usedPercent)
        remainingPercent = try? c.decodeIfPresent(Double.self, forKey: .remainingPercent)
        resetsAt = try? c.decodeIfPresent(Date.self, forKey: .resetsAt)
        let rawBoundaryKind = (try c.decodeIfPresent(String.self, forKey: .boundaryKind) ?? "").lowercased()
        boundaryKind = ["reset", "expiry", "mixed"].contains(rawBoundaryKind) ? rawBoundaryKind : nil
        windowMinutes = try? c.decodeIfPresent(Double.self, forKey: .windowMinutes)
        remaining = try? c.decodeIfPresent(Double.self, forKey: .remaining)
        used = try? c.decodeIfPresent(Double.self, forKey: .used)
        currency = try? c.decodeIfPresent(String.self, forKey: .currency)
        let rawDetail = (try c.decodeIfPresent(String.self, forKey: .detail) ?? "").lowercased()
        detail = rawDetail == "unlimited" ? rawDetail : nil
    }
}

extension WidgetModel {
    private enum CodingKeys: String, CodingKey { case id, displayName, totalTokens, costUsd, sharePercent }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        displayName = try c.decode(String.self, forKey: .displayName)
        totalTokens = try c.decode(Int.self, forKey: .totalTokens)
        costUsd = try c.decode(Double.self, forKey: .costUsd)
        sharePercent = try c.decode(Double.self, forKey: .sharePercent)
        let decodedID = try c.decode(String.self, forKey: .id)
        guard !decodedID.isEmpty else {
            throw DecodingError.dataCorruptedError(
                forKey: .id,
                in: c,
                debugDescription: "Widget model is missing its current-schema identifier"
            )
        }
        modelId = decodedID
    }
}

extension WidgetTool {
    private enum CodingKeys: String, CodingKey { case id, totalTokens, costUsd, sharePercent }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        totalTokens = try c.decode(Int.self, forKey: .totalTokens)
        costUsd = try c.decode(Double.self, forKey: .costUsd)
        sharePercent = try c.decode(Double.self, forKey: .sharePercent)
    }
}

extension WidgetActivityDay {
    private enum CodingKeys: String, CodingKey { case date, intensity, totalTokens, costUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        intensity = try c.decode(Int.self, forKey: .intensity)
        totalTokens = max(0, try c.decode(Int.self, forKey: .totalTokens))
        costUsd = max(0, try c.decode(Double.self, forKey: .costUsd))
    }
}

extension WidgetActivity {
    private enum CodingKeys: String, CodingKey { case activeDays, days }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        activeDays = try c.decode(Int.self, forKey: .activeDays)
        days = try c.decode([WidgetActivityDay].self, forKey: .days)
    }
}

extension WidgetTrendPoint {
    private enum CodingKeys: String, CodingKey { case date, totalTokens, costUsd }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        date = try c.decode(String.self, forKey: .date)
        totalTokens = try c.decode(Int.self, forKey: .totalTokens)
        costUsd = max(0, try c.decode(Double.self, forKey: .costUsd))
    }
}

extension WidgetTrend {
    private enum CodingKeys: String, CodingKey { case points }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        points = try c.decode([WidgetTrendPoint].self, forKey: .points)
    }
}

extension WidgetPresentation {
    private enum CodingKeys: String, CodingKey { case currencyCode, currencySymbol, currencyRate, numberStyle, compactTokenUnits, showCost, locale, theme }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        currencyCode = try c.decode(String.self, forKey: .currencyCode)
        currencySymbol = try c.decode(String.self, forKey: .currencySymbol)
        currencyRate = try c.decode(Double.self, forKey: .currencyRate)
        numberStyle = try c.decode(String.self, forKey: .numberStyle)
        compactTokenUnits = try c.decode(String.self, forKey: .compactTokenUnits)
        showCost = try c.decode(Bool.self, forKey: .showCost)
        locale = try c.decode(String.self, forKey: .locale)
        theme = try c.decode(String.self, forKey: .theme)
    }
}

extension WidgetStatus {
    private enum CodingKeys: String, CodingKey { case isStale, sourceUpdatedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isStale = try c.decode(Bool.self, forKey: .isStale)
        sourceUpdatedAt = try? c.decodeIfPresent(Date.self, forKey: .sourceUpdatedAt)
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
        schemaVersion: currentSchemaVersion,
        generatedAt: Date(),
        quota: [
            WidgetQuotaProvider(instanceId: "codex-single", provider: "codex", status: "ok", updatedAt: Date(), windows: [WidgetLimitWindow(kind: "weekly", remainingPercent: 2, resetsAt: Date().addingTimeInterval(6 * 86_400))]),
            WidgetQuotaProvider(instanceId: "mimo-single", provider: "mimo", status: "ok", updatedAt: Date(), windows: [], balance: WidgetQuotaBalance(amount: 3.62, currency: "CNY")),
            WidgetQuotaProvider(instanceId: "deepseek-single", provider: "deepseek", status: "ok", updatedAt: Date(), windows: [], balance: WidgetQuotaBalance(amount: 9.33, currency: "CNY")),
            WidgetQuotaProvider(instanceId: "antigravity-single", provider: "antigravity", status: "notConfigured", updatedAt: Date(), windows: [])
        ],
        periods: [
            .day: WidgetPeriodSnapshot(
                overview: WidgetOverview(totalTokens: 27_800_000, costUsd: 14.86),
                tools: [WidgetTool(id: "codex", totalTokens: 22_300_000, sharePercent: 80), WidgetTool(id: "claude", totalTokens: 5_500_000, sharePercent: 20)],
                models: [WidgetModel(id: "model-gpt-5-6", displayName: "GPT-5.6", totalTokens: 20_900_000, sharePercent: 75), WidgetModel(id: "model-mimo", displayName: "MiMo", totalTokens: 2_900_000, sharePercent: 11)],
                activity: WidgetActivity(activeDays: 1, days: placeholderActivityDays(count: 7)),
                trend: WidgetTrend(points: (1...14).map { WidgetTrendPoint(date: "\($0)", totalTokens: $0 * 200_000) })
            ),
            .month: WidgetPeriodSnapshot(
                overview: WidgetOverview(totalTokens: 61_200_000, costUsd: 237.42),
                tools: [WidgetTool(id: "codex", totalTokens: 48_900_000, sharePercent: 80), WidgetTool(id: "claude", totalTokens: 12_300_000, sharePercent: 20)],
                models: [WidgetModel(id: "model-gpt-5-6", displayName: "GPT-5.6", totalTokens: 44_000_000, sharePercent: 72), WidgetModel(id: "model-mimo", displayName: "MiMo", totalTokens: 7_000_000, sharePercent: 11)],
                activity: WidgetActivity(activeDays: 18, days: placeholderActivityDays(count: 28)),
                trend: WidgetTrend(points: (1...14).map { WidgetTrendPoint(date: "\($0)", totalTokens: $0 * 340_000) })
            ),
            .total: WidgetPeriodSnapshot(
                overview: WidgetOverview(totalTokens: 180_000_000, costUsd: 620.15),
                tools: [WidgetTool(id: "codex", totalTokens: 144_000_000, sharePercent: 80), WidgetTool(id: "claude", totalTokens: 36_000_000, sharePercent: 20)],
                models: [WidgetModel(id: "model-gpt-5-6", displayName: "GPT-5.6", totalTokens: 120_000_000, sharePercent: 67), WidgetModel(id: "model-mimo", displayName: "MiMo", totalTokens: 30_000_000, sharePercent: 17)],
                activity: WidgetActivity(activeDays: 144, days: placeholderActivityDays(count: 180)),
                trend: WidgetTrend(points: (1...14).map { WidgetTrendPoint(date: "\($0)", totalTokens: $0 * 900_000) })
            )
        ],
        presentation: .default,
        status: WidgetStatus(isStale: false, sourceUpdatedAt: Date())
    )
}
