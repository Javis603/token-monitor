import Foundation
import SwiftUI

enum WidgetL10n {
    static func text(_ key: String.LocalizationValue) -> String {
        String(localized: key)
    }

    static func format(_ key: String.LocalizationValue, _ arguments: CVarArg...) -> String {
        String(format: String(localized: key), locale: Locale.current, arguments: arguments)
    }
}
enum WidgetDesignTokens {
    static let smallGap: CGFloat = 5
    static let mediumGap: CGFloat = 10
    static let largeGap: CGFloat = 8
    static let secondarySize: CGFloat = 10
    static let microSize: CGFloat = 9
    static let dashboardMetricSize: CGFloat = 42
    static let dashboardSectionTitleSize: CGFloat = 10
    // Preserve the original dashboard quota density across both quota and
    // breakdown rows so one section never forces the other to truncate.
    static let dashboardRowLabelSize: CGFloat = 10
    static let dashboardValueSize: CGFloat = 8.5
    static let dashboardDetailSize: CGFloat = 7.5
    static let dashboardTrendHeight: CGFloat = 34
    static let dividerOpacity = 0.14
    static let accent = Color.accentColor
    static let chartBlue = Color(red: 115 / 255, green: 189 / 255, blue: 245 / 255)
    static let number = Color(red: 243 / 255, green: 251 / 255, blue: 247 / 255)
    static let muted = Color(red: 163 / 255, green: 173 / 255, blue: 187 / 255)
}

enum WidgetTrendChange {
    static func label(for snapshot: WidgetSnapshot, period: WidgetPeriod) -> String {
        guard period == .total else { return label(for: snapshot.trend.points) }
        guard let totalTokens = snapshot.periods[.total]?.overview.totalTokens,
              let currentMonthTokens = snapshot.periods[.month]?.overview.totalTokens else { return "—" }
        return totalGrowthLabel(totalTokens: totalTokens, currentMonthTokens: currentMonthTokens)
    }

    static func label(for points: [WidgetTrendPoint]) -> String {
        guard let first = points.first(where: { $0.totalTokens > 0 })?.totalTokens,
              let last = points.last?.totalTokens else { return "—" }
        return label(percent: (Double(last) - Double(first)) / Double(first) * 100)
    }

    static func totalGrowthLabel(totalTokens: Int, currentMonthTokens: Int) -> String {
        guard totalTokens > 0 else { return "—" }
        let boundedMonthTokens = min(max(0, currentMonthTokens), totalTokens)
        let previousTotal = totalTokens - boundedMonthTokens
        guard previousTotal > 0 else { return "—" }
        return label(percent: Double(boundedMonthTokens) / Double(previousTotal) * 100)
    }

    private static func label(percent rawPercent: Double) -> String {
        let percent = Int(rawPercent.rounded())
        if percent == 0 { return "0%" }
        return percent > 0 ? "+\(percent)%" : "−\(abs(percent))%"
    }
}

struct WidgetHeatmapCell: Equatable, Identifiable {
    let date: String
    let intensity: Int
    let totalTokens: Int
    let isSelectable: Bool
    let isFuture: Bool

    var id: String { date }
}

struct WidgetHeatmapLayout: Equatable {
    let weekCount: Int
    let cellWidth: CGFloat
    let cellHeight: CGFloat
    let spacing: CGFloat
    let cells: [WidgetHeatmapCell]
    let startDate: String?
    let endDate: String?

    var cellSize: CGFloat {
        min(cellWidth, cellHeight)
    }

    var renderedWidth: CGFloat {
        guard weekCount > 0 else { return 0 }
        return CGFloat(weekCount) * cellWidth + CGFloat(weekCount - 1) * spacing
    }

    var renderedHeight: CGFloat {
        guard weekCount > 0 else { return 0 }
        return 7 * cellHeight + 6 * spacing
    }

    func cell(week: Int, weekday: Int) -> WidgetHeatmapCell? {
        guard week >= 0, week < weekCount, weekday >= 0, weekday < 7 else { return nil }
        return cells[week * 7 + weekday]
    }
}

enum WidgetHeatmapLayoutCalculator {
    static func make(
        days: [WidgetActivityDay],
        referenceDate: Date,
        availableSize: CGSize,
        maxWeeks: Int,
        minCellSize: CGFloat,
        maxCellSize: CGFloat,
        spacing: CGFloat,
        timeZone: TimeZone = .current
    ) -> WidgetHeatmapLayout {
        make(
            days: days,
            referenceDate: referenceDate,
            availableSize: availableSize,
            maxWeeks: maxWeeks,
            minCellWidth: minCellSize,
            minCellHeight: minCellSize,
            maxCellWidth: maxCellSize,
            maxCellHeight: maxCellSize,
            spacing: spacing,
            minimumWidthRatio: nil,
            allowsVerticalOverflow: false,
            timeZone: timeZone
        )
    }

    static func make(
        days: [WidgetActivityDay],
        referenceDate: Date,
        availableSize: CGSize,
        maxWeeks: Int,
        minCellWidth: CGFloat,
        minCellHeight: CGFloat,
        maxCellWidth: CGFloat,
        maxCellHeight: CGFloat,
        spacing: CGFloat,
        minimumWidthRatio: CGFloat?,
        allowsVerticalOverflow: Bool,
        timeZone: TimeZone = .current
    ) -> WidgetHeatmapLayout {
        let normalizedSpacing = max(0, spacing)
        let normalizedMaxWeeks = max(0, maxWeeks)
        guard normalizedMaxWeeks > 0, availableSize.width > 0, availableSize.height > 0 else {
            return empty(spacing: normalizedSpacing)
        }

        // One calendar for the whole grid: the keys, "today" and every cell
        // offset have to agree on a zone. See WidgetActivityDate for why it is
        // the local one and not UTC.
        let calendar = WidgetActivityDate.calendar(timeZone: timeZone)
        var values: [Date: WidgetActivityDay] = [:]
        for day in days {
            guard let date = parse(day.date, calendar: calendar) else { continue }
            let existing = values[date]
            values[date] = WidgetActivityDay(
                date: day.date,
                intensity: max(existing?.intensity ?? 0, min(4, max(0, day.intensity))),
                totalTokens: max(existing?.totalTokens ?? 0, day.totalTokens)
            )
        }
        guard let earliest = values.keys.min() else { return empty(spacing: normalizedSpacing) }

        let reference = calendar.startOfDay(for: referenceDate)
        let referenceSunday = sunday(for: reference, calendar: calendar)
        let earliestSunday = sunday(for: min(earliest, reference), calendar: calendar)
        let coverageDays = max(0, calendar.dateComponents([.day], from: earliestSunday, to: referenceSunday).day ?? 0)
        let coverageWeeks = max(1, coverageDays / 7 + 1)
        let widthCapacity = maxWeekCapacity(
            width: availableSize.width,
            minCellSize: max(0.1, minCellWidth),
            spacing: normalizedSpacing
        )
        let weekCount = min(normalizedMaxWeeks, coverageWeeks, widthCapacity)
        guard weekCount > 0 else { return empty(spacing: normalizedSpacing) }

        let widthFit = (availableSize.width - CGFloat(weekCount - 1) * normalizedSpacing) / CGFloat(weekCount)
        let heightFit = (availableSize.height - 6 * normalizedSpacing) / 7
        if minimumWidthRatio == nil,
           allowsVerticalOverflow == false,
           minCellWidth == minCellHeight,
           maxCellWidth == maxCellHeight {
            let cellSize = max(0, min(maxCellWidth, widthFit, heightFit))
            guard cellSize > 0 else { return empty(spacing: normalizedSpacing) }
            return makeLayout(
                weekCount: weekCount,
                cellWidth: cellSize,
                cellHeight: cellSize,
                spacing: normalizedSpacing,
                values: values,
                earliest: earliest,
                reference: reference,
                referenceSunday: referenceSunday,
                calendar: calendar
            )
        }
        let targetWidthFit: CGFloat
        if let minimumWidthRatio {
            let boundedRatio = max(0, min(1, minimumWidthRatio))
            targetWidthFit = (availableSize.width * boundedRatio - CGFloat(weekCount - 1) * normalizedSpacing) / CGFloat(weekCount)
        } else {
            targetWidthFit = 0
        }
        let cellWidth = max(0, min(maxCellWidth, widthFit, max(minCellWidth, targetWidthFit)))
        let unconstrainedCellHeight = allowsVerticalOverflow ? max(minCellHeight, heightFit) : heightFit
        let cellHeight = max(0, min(maxCellHeight, unconstrainedCellHeight))
        guard cellWidth > 0, cellHeight > 0 else { return empty(spacing: normalizedSpacing) }

        return makeLayout(
            weekCount: weekCount,
            cellWidth: cellWidth,
            cellHeight: cellHeight,
            spacing: normalizedSpacing,
            values: values,
            earliest: earliest,
            reference: reference,
            referenceSunday: referenceSunday,
            calendar: calendar
        )
    }

    private static func makeLayout(
        weekCount: Int,
        cellWidth: CGFloat,
        cellHeight: CGFloat,
        spacing: CGFloat,
        values: [Date: WidgetActivityDay],
        earliest: Date,
        reference: Date,
        referenceSunday: Date,
        calendar: Calendar
    ) -> WidgetHeatmapLayout {
        let gridStart = calendar.date(byAdding: .day, value: -(weekCount - 1) * 7, to: referenceSunday) ?? referenceSunday
        var cells: [WidgetHeatmapCell] = []
        cells.reserveCapacity(weekCount * 7)
        for offset in 0..<(weekCount * 7) {
            guard let date = calendar.date(byAdding: .day, value: offset, to: gridStart) else { continue }
            let isFuture = date > reference
            let activityDay = values[date]
            cells.append(WidgetHeatmapCell(
                date: format(date, calendar: calendar),
                intensity: isFuture ? 0 : activityDay?.intensity ?? 0,
                totalTokens: isFuture ? 0 : activityDay?.totalTokens ?? 0,
                isSelectable: !isFuture && date >= earliest,
                isFuture: isFuture
            ))
        }

        return WidgetHeatmapLayout(
            weekCount: weekCount,
            cellWidth: cellWidth,
            cellHeight: cellHeight,
            spacing: spacing,
            cells: cells,
            startDate: cells.first?.date,
            endDate: cells.last(where: { !$0.isFuture })?.date
        )
    }

    private static func maxWeekCapacity(width: CGFloat, minCellSize: CGFloat, spacing: CGFloat) -> Int {
        let pitch = minCellSize + spacing
        guard pitch > 0 else { return 0 }
        return max(0, Int(floor((width + spacing) / pitch)))
    }

    private static func sunday(for date: Date, calendar: Calendar) -> Date {
        let weekday = calendar.component(.weekday, from: date)
        return calendar.date(byAdding: .day, value: -(weekday - 1), to: date) ?? date
    }

    private static func parse(_ value: String, calendar: Calendar) -> Date? {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4,
              parts[1].count == 2,
              parts[2].count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2]),
              let date = calendar.date(from: DateComponents(year: year, month: month, day: day)),
              format(date, calendar: calendar) == value else { return nil }
        return date
    }

    private static func format(_ date: Date, calendar: Calendar) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    private static func empty(spacing: CGFloat) -> WidgetHeatmapLayout {
        WidgetHeatmapLayout(
            weekCount: 0,
            cellWidth: 0,
            cellHeight: 0,
            spacing: spacing,
            cells: [],
            startDate: nil,
            endDate: nil
        )
    }

}

enum WidgetQuotaSelectionResolver {
    static func providers(
        in snapshot: WidgetSnapshot,
        mode: WidgetQuotaMode,
        selectedIDs: [String],
        limit: Int,
        at date: Date
    ) -> [WidgetQuotaProvider] {
        guard mode == .custom else {
            let ranked = snapshot.quota.enumerated().sorted { left, right in
                let leftRank = automaticRank(left.element, at: date)
                let rightRank = automaticRank(right.element, at: date)
                // Provider refreshes finish at different times. Keep snapshot order
                // within the same health class so Automatic does not churn accounts.
                return leftRank == rightRank ? left.offset < right.offset : leftRank < rightRank
            }
            return Array(ranked.prefix(limit).map(\.element))
        }
        let providersByID = Dictionary(uniqueKeysWithValues: snapshot.quota.map { ($0.instanceId, $0) })
        var seenProviderIDs = Set<String>()
        let selected = selectedIDs.compactMap { id -> WidgetQuotaProvider? in
            let provider = id == WidgetQuotaSelectionID.currentCodexAccount
                ? snapshot.quota.first { $0.provider.caseInsensitiveCompare("codex") == .orderedSame && $0.isCurrentAccount }
                : providersByID[id]
            guard let provider, seenProviderIDs.insert(provider.instanceId).inserted else { return nil }
            return provider
        }
        return Array(selected.prefix(limit))
    }

    private static func automaticRank(_ provider: WidgetQuotaProvider, at date: Date) -> Int {
        let hasQuotaData = provider.balance != nil || !provider.windows.isEmpty
        let isAvailable = provider.status == "ok"
        let isStale = WidgetQuotaFreshness.isStale(provider, at: date)
        return (hasQuotaData ? 0 : 4) + (isAvailable ? 0 : 2) + (isStale ? 1 : 0)
    }
}

enum WidgetQuotaFreshness {
    static func isStale(
        _ provider: WidgetQuotaProvider,
        at date: Date,
        threshold: TimeInterval = 20 * 60
    ) -> Bool {
        guard provider.status == "ok" else { return true }
        guard let updatedAt = provider.updatedAt else { return true }
        return date.timeIntervalSince(updatedAt) > threshold
    }
}

enum WidgetQuotaPresentation {
    static func windows(
        for provider: WidgetQuotaProvider,
        limit: Int,
        reserveBalanceSlot: Bool = true
    ) -> [WidgetLimitWindow] {
        guard limit > 0 else { return [] }

        let regular = provider.windows.filter { $0.metric != "credits" && $0.metric != "spend" }
        let credits = provider.windows.first { $0.metric == "credits" } ?? provider.balance.map {
            WidgetLimitWindow(
                kind: "billing",
                remainingPercent: nil,
                resetsAt: nil,
                metric: "credits",
                showMeter: false,
                remaining: $0.amount,
                currency: $0.currency,
                label: "Balance"
            )
        }
        let spend = provider.windows.first { $0.metric == "spend" } ?? provider.balance?.allTimeSpend.map {
            WidgetLimitWindow(
                kind: "billing",
                remainingPercent: nil,
                resetsAt: nil,
                metric: "spend",
                showMeter: false,
                used: $0,
                currency: provider.balance?.currency,
                label: "Spend"
            )
        }

        let regularLimit = reserveBalanceSlot && credits != nil ? max(0, limit - 1) : limit
        var result = Array(regular.prefix(regularLimit))
        if let credits, result.count < limit { result.append(credits) }
        if let spend, result.count < limit { result.append(spend) }
        if result.count < limit {
            let selectedIDs = Set(result.map(\.id))
            result.append(contentsOf: provider.windows.filter { !selectedIDs.contains($0.id) }.prefix(limit - result.count))
        }
        return result
    }
}

enum WidgetFormat {
    static func tokens(_ value: Int, style: String = "compact") -> String {
        tokens(value, style: style, unitSystem: "western", locale: "auto")
    }

    static func tokens(_ value: Int, style: String = "compact", presentation: WidgetPresentation) -> String {
        tokens(value, style: style, unitSystem: presentation.compactTokenUnits, locale: presentation.locale)
    }

    private static func tokens(_ value: Int, style: String, unitSystem: String, locale: String) -> String {
        guard style == "compact" else { return value.formatted(.number.grouping(.automatic)) }

        let language = normalizedLocale(locale)
        let isChinese = language == "zh" || language.hasPrefix("zh-")
        let isJapanese = language == "ja" || language.hasPrefix("ja-")
        let isKorean = language == "ko" || language.hasPrefix("ko-")
        guard unitSystem == "localized", isChinese || isJapanese || isKorean else {
            switch value {
            case 1_000_000_000...: return String(format: "%.1fB", Double(value) / 1_000_000_000)
            case 1_000_000...: return String(format: "%.1fM", Double(value) / 1_000_000)
            case 1_000...: return String(format: "%.1fK", Double(value) / 1_000)
            default: return value.formatted()
            }
        }

        let suffixes: [String]
        if isKorean {
            suffixes = ["\u{B9CC}", "\u{C5B5}"]
        } else if isJapanese {
            suffixes = ["\u{4E07}", "\u{5104}"]
        } else {
            let simplified = language.hasPrefix("zh-hans")
                || language == "zh-cn" || language.hasPrefix("zh-cn-")
                || language == "zh-sg" || language.hasPrefix("zh-sg-")
                || language == "zh-my" || language.hasPrefix("zh-my-")
            suffixes = simplified ? ["\u{4E07}", "\u{4EBF}"] : ["\u{842C}", "\u{5104}"]
        }
        let divisors: [Double] = [1e4, 1e8]
        let absolute = abs(Double(value))
        var unitIndex = -1
        for index in stride(from: divisors.count - 1, through: 0, by: -1) {
            if absolute >= divisors[index] {
                unitIndex = index
                break
            }
        }
        guard unitIndex >= 0 else { return String(value) }

        func formatScaled(_ scaled: Double) -> String {
            let decimals = abs(scaled) < 10 ? 2 : 1
            return decimals == 2
                ? String(format: "%.2f", scaled)
                : String(format: "%.1f", scaled)
        }

        var display = formatScaled(Double(value) / divisors[unitIndex])
        if abs(Double(display) ?? 0) >= 10_000, unitIndex < divisors.count - 1 {
            unitIndex += 1
            display = formatScaled(Double(value) / divisors[unitIndex])
        }
        while display.last == "0" { display.removeLast() }
        if display.last == "." { display.removeLast() }
        return "\(display)\(suffixes[unitIndex])"
    }

    private static func normalizedLocale(_ value: String) -> String {
        let source = value.lowercased() == "auto" ? Locale.current.identifier : value
        return source.replacingOccurrences(of: "_", with: "-").lowercased()
    }

    static func cost(_ usd: Double, presentation: WidgetPresentation) -> String {
        let converted = usd * presentation.currencyRate
        return "\(presentation.currencySymbol)\(String(format: "%.2f", converted))"
    }

    // Mirrors LIMIT_PROVIDERS in src/electron/renderer/app.js — the widget must
    // name a provider exactly the way the app does. Kept complete rather than
    // leaning on the `default` branch: `.capitalized` happens to be right for a
    // few ids and silently wrong for the rest, and it collapsed zai/zaiteam
    // onto one label. tests/electron/macWidgetProviderLabels.test.js fails when
    // this list and the renderer's drift apart.
    static func provider(_ value: String) -> String {
        switch value.lowercased() {
        case "claude": "Claude"
        case "codex": "Codex"
        case "opencode": "OpenCode"
        case "hermes": "Hermes Agent"
        case "cursor": "Cursor"
        case "antigravity": "Antigravity"
        case "factory": "Factory Droid"
        case "kimi": "Kimi"
        case "grok": "Grok"
        case "copilot": "GitHub Copilot"
        case "zed": "Zed"
        case "commandcode": "Command Code"
        case "mimo": "MiMo"
        case "micode": "MiMo Code"
        case "zai": "GLM"
        case "zaiteam": "GLM Team"
        case "kiro": "Kiro"
        case "workbuddy": "WorkBuddy"
        case "qoder": "Qoder"
        case "deepseek": "DeepSeek"
        case "lmstudio": "LM Studio"
        case "openrouter": "OpenRouter"
        case "minimax": "Minimax"
        case "volcengine": "Volcengine"
        case "ollama": "Ollama"
        case "trae": "Trae CN"
        case "alibaba": "Alibaba Cloud"
        case "thirdparty": "Third-party APIs"
        default: value.capitalized
        }
    }

    static func quotaValue(_ provider: WidgetQuotaProvider) -> String {
        if let window = provider.windows.first,
           window.metric == "credits",
           window.detail == "unlimited" {
            return WidgetL10n.text("Unlimited")
        }
        if let balance = provider.balance, balance.amount.isFinite {
            return WidgetL10n.format("%@ left", quotaAmount(balance.amount, currency: balance.currency))
        }
        if let window = provider.windows.first,
           window.metric == "credits",
           let remaining = window.remaining,
           remaining.isFinite {
            return WidgetL10n.format("%@ left", quotaAmount(remaining, currency: window.currency))
        }
        if provider.windows.first?.metric != "credits",
           let remaining = provider.windows.first?.remainingPercent {
            return WidgetL10n.format("%lld%% left", Int(remaining.rounded()))
        }
        return provider.displayStatus
    }

    static func windowValue(_ window: WidgetLimitWindow) -> String {
        if window.metric == "credits", window.detail == "unlimited" {
            return WidgetL10n.text("Unlimited")
        }
        if window.metric == "credits", let remaining = window.remaining, remaining.isFinite {
            return quotaAmount(remaining, currency: window.currency)
        }
        if window.metric == "spend", let used = window.used, used.isFinite {
            return quotaAmount(used, currency: window.currency)
        }
        if let remaining = window.remainingPercent, remaining.isFinite {
            return WidgetL10n.format("%lld%% left", Int(remaining.rounded()))
        }
        return "—"
    }

    private static func quotaAmount(_ value: Double, currency: String?) -> String {
        let amount = String(format: "%.2f", locale: Locale(identifier: "en_US_POSIX"), value)
        return switch currency?.uppercased() {
        case "CNY": "¥\(amount)"
        case "USD": "$\(amount)"
        case "TWD": "NT$\(amount)"
        case "HKD": "HK$\(amount)"
        case "CREDITS": "\(amount) credits"
        case .some(let code) where !code.isEmpty: "\(code) \(amount)"
        default: amount
        }
    }

    static func boundary(_ window: WidgetLimitWindow) -> String {
        guard let date = window.resetsAt else { return "" }
        return boundary(date, kind: window.boundaryKind ?? "reset", now: Date())
    }

    static func boundary(_ date: Date, kind: String, now: Date) -> String {
        let interval = date.timeIntervalSince(now)
        let duration = compactDuration(seconds: max(0, interval))
        if kind == "expiry" {
            return WidgetL10n.format("Expires in %@", duration)
        }
        if kind == "mixed" {
            if interval <= 0 { return WidgetL10n.text("Changes now") }
            return WidgetL10n.format("Changes in %@", duration)
        }
        return WidgetL10n.format("Reset in %@", duration)
    }

    static func compactDuration(seconds: TimeInterval) -> String {
        let totalMinutes = max(1, Int(ceil(max(0, seconds) / 60)))
        let components = [
            (totalMinutes / (24 * 60), "d"),
            ((totalMinutes / 60) % 24, "h"),
            (totalMinutes % 60, "m")
        ]
        let visible = components
            .filter { $0.0 > 0 }
            .prefix(2)
            .map { "\($0.0)\($0.1)" }
        return visible.isEmpty ? "1m" : visible.joined(separator: " ")
    }

    static func windowTitle(_ window: WidgetLimitWindow) -> String {
        if let label = window.label?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
            return label
        }
        return switch window.kind.lowercased() {
        case "session", "five_hour", "five-hour", "5h", "5-hour": "Session"
        case "weekly", "week", "7d", "seven_day", "seven-day": "Weekly"
        case "monthly", "month": "Monthly"
        default: window.kind.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
}
