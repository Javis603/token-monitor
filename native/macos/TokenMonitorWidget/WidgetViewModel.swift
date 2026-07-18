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
import WidgetKit

enum WidgetDesignTokens {
    static let sectionPadding: CGFloat = 9
    static let cornerRadius: CGFloat = 12
    static let smallGap: CGFloat = 5
    static let mediumGap: CGFloat = 10
    static let largeGap: CGFloat = 8
    static let titleSize: CGFloat = 15
    static let smallPrimarySize: CGFloat = 27
    static let mediumPrimarySize: CGFloat = 31
    static let largePrimarySize: CGFloat = 34
    static let secondarySize: CGFloat = 10
    static let microSize: CGFloat = 9
    static let dividerOpacity = 0.14
    static let panelOpacity = 0.065
    static let accent = Color.accentColor
    static let periodControlHeight: CGFloat = 17
    static let pageControlHeight: CGFloat = 18
    static let openButtonSize: CGFloat = 20
}

struct WidgetScaffoldGeometry: Equatable {
    let headerHeight: CGFloat
    let footerHeight: CGFloat
    let contentGap: CGFloat

    var contentTopReserved: CGFloat {
        headerHeight + contentGap
    }

    var contentBottomReserved: CGFloat {
        footerHeight + contentGap
    }

    func contentHeight(for availableHeight: CGFloat) -> CGFloat {
        max(0, availableHeight - contentTopReserved - contentBottomReserved)
    }

    func regionFrames(for size: CGSize) -> WidgetScaffoldRegionFrames {
        let contentHeight = contentHeight(for: size.height)
        return WidgetScaffoldRegionFrames(
            header: CGRect(x: 0, y: 0, width: size.width, height: headerHeight),
            content: CGRect(
                x: 0,
                y: contentTopReserved,
                width: size.width,
                height: contentHeight
            ),
            footer: CGRect(
                x: 0,
                y: max(0, size.height - footerHeight),
                width: size.width,
                height: footerHeight
            )
        )
    }
}

struct WidgetScaffoldRegionFrames: Equatable {
    let header: CGRect
    let content: CGRect
    let footer: CGRect
}

struct WidgetLayoutMetrics: Equatable {
    let outerTopInset: CGFloat
    let outerBottomInset: CGFloat
    let horizontalInset: CGFloat
    let headerHeight: CGFloat
    let footerHeight: CGFloat
    let contentGap: CGFloat
    let pageControlWidth: CGFloat
    let activityMinCellSize: CGFloat
    let activityMaxCellSize: CGFloat
    let activityCellSpacing: CGFloat

    var outerInsets: EdgeInsets {
        EdgeInsets(
            top: outerTopInset,
            leading: horizontalInset,
            bottom: outerBottomInset,
            trailing: horizontalInset
        )
    }

    var scaffoldGeometry: WidgetScaffoldGeometry {
        WidgetScaffoldGeometry(
            headerHeight: headerHeight,
            footerHeight: footerHeight,
            contentGap: contentGap
        )
    }

    static let small = WidgetLayoutMetrics(
        outerTopInset: 0,
        outerBottomInset: 0,
        horizontalInset: 0,
        headerHeight: 20,
        footerHeight: 25,
        contentGap: WidgetDesignTokens.smallGap,
        pageControlWidth: 108,
        activityMinCellSize: 5,
        activityMaxCellSize: 16,
        activityCellSpacing: 2
    )

    static let medium = WidgetLayoutMetrics(
        outerTopInset: 0,
        outerBottomInset: 0,
        horizontalInset: 0,
        headerHeight: 22,
        footerHeight: 26,
        contentGap: WidgetDesignTokens.mediumGap,
        pageControlWidth: 112,
        activityMinCellSize: 5,
        activityMaxCellSize: 20,
        activityCellSpacing: 2
    )

    static let large = WidgetLayoutMetrics(
        outerTopInset: 0,
        outerBottomInset: 0,
        horizontalInset: 0,
        headerHeight: 24,
        footerHeight: 28,
        contentGap: WidgetDesignTokens.largeGap,
        pageControlWidth: 112,
        activityMinCellSize: 5,
        activityMaxCellSize: 22,
        activityCellSpacing: 2
    )

    static func metrics(for family: WidgetFamily) -> WidgetLayoutMetrics {
        switch family {
        case .systemLarge: .large
        case .systemMedium: .medium
        default: .small
        }
    }
}

enum WidgetLayout: CaseIterable, Equatable {
    case small
    case medium
    case large
}

enum WidgetContentDensity: CaseIterable, Equatable {
    case regular
    case compact
    case summary
}

struct WidgetMediumActivityLayoutPlan: Equatable {
    let summaryWidth: CGFloat
    let heatmapWidth: CGFloat
    let spacing: CGFloat

    static func make(availableSize: CGSize) -> WidgetMediumActivityLayoutPlan {
        let spacing: CGFloat = availableSize.width >= 300 ? 12 : 8
        let contentWidth = max(0, availableSize.width)
        let usableWidth = max(0, contentWidth - spacing)
        let targetSummaryWidth = contentWidth * 0.42
        let minSummaryWidth = min(112, usableWidth)
        let maxSummaryWidth = usableWidth * 0.48
        let summaryWidth = max(0, min(maxSummaryWidth, max(minSummaryWidth, targetSummaryWidth)))
        let heatmapWidth = max(0, usableWidth - summaryWidth)

        return WidgetMediumActivityLayoutPlan(
            summaryWidth: summaryWidth,
            heatmapWidth: heatmapWidth,
            spacing: spacing
        )
    }
}

enum WidgetListKind: Equatable {
    case quota
    case models
}

struct WidgetListDensityGeometry: Equatable {
    let rowHeight: CGFloat
    let rowSpacing: CGFloat
    let moreRowHeight: CGFloat

    func fullHeight(itemCount: Int) -> CGFloat {
        guard itemCount > 0 else { return 0 }
        return CGFloat(itemCount) * rowHeight + CGFloat(itemCount - 1) * rowSpacing
    }
}

struct WidgetListLayoutPlan: Equatable {
    let density: WidgetContentDensity
    let visibleCount: Int
    let hiddenCount: Int
    let rowHeight: CGFloat
    let rowSpacing: CGFloat
    let moreRowHeight: CGFloat
}

struct WidgetLargeListLayoutPlan: Equatable {
    let visibleCount: Int
    let hiddenCount: Int
    let rowHeight: CGFloat
    let rowSpacing: CGFloat
    let moreRowHeight: CGFloat
    let nameFontSize: CGFloat
    let percentFontSize: CGFloat
    let tokenFontSize: CGFloat
    let barHeight: CGFloat

    static func make(itemCount: Int, availableHeight: CGFloat) -> WidgetLargeListLayoutPlan {
        let count = max(0, itemCount)
        let height = max(0, availableHeight)
        let spacing: CGFloat = 3
        let moreHeight: CGFloat = 12
        let minHeight: CGFloat = 30
        let maxHeight: CGFloat = 38

        let visibleCount: Int
        let rowHeight: CGFloat
        let hiddenCount: Int

        if count == 0 {
            visibleCount = 0; rowHeight = 0; hiddenCount = 0
        } else if count == 1 {
            visibleCount = 1; rowHeight = min(maxHeight, height); hiddenCount = 0
        } else {
            let stride = minHeight + spacing
            let maxFit = stride > 0 ? Int(floor((height + spacing) / stride)) : 0
            let trialCount = min(count, max(maxFit, 1))
            let totalSpacing = CGFloat(max(0, trialCount - 1)) * spacing
            let computedHeight = (height - totalSpacing) / CGFloat(trialCount)
            let clampedHeight = max(minHeight, min(maxHeight, computedHeight))
            let needsMore = count > trialCount
            let moreActualHeight = needsMore ? moreHeight : 0
            let checkCount = needsMore ? trialCount : trialCount
            let finalCount = min(count, max(checkCount, 1))
            let finalTotalSpacing = CGFloat(max(0, finalCount - 1)) * spacing
            let finalRowHeight = needsMore
                ? max(minHeight, min(maxHeight, (height - moreActualHeight - finalTotalSpacing) / CGFloat(finalCount)))
                : clampedHeight
            visibleCount = finalCount
            rowHeight = finalRowHeight
            hiddenCount = count - finalCount
        }

        let nameSize: CGFloat = 11
        let pctSize: CGFloat = 10
        let tokenSize: CGFloat = 9
        let barH: CGFloat = rowHeight >= 34 ? 3 : 2

        return WidgetLargeListLayoutPlan(
            visibleCount: visibleCount,
            hiddenCount: hiddenCount,
            rowHeight: rowHeight,
            rowSpacing: spacing,
            moreRowHeight: moreHeight,
            nameFontSize: nameSize,
            percentFontSize: pctSize,
            tokenFontSize: tokenSize,
            barHeight: barH
        )
    }
}

enum WidgetListCapacity {
    static func geometry(kind: WidgetListKind, density: WidgetContentDensity) -> WidgetListDensityGeometry {
        switch (kind, density) {
        case (.quota, .regular):
            WidgetListDensityGeometry(rowHeight: 30, rowSpacing: 3, moreRowHeight: 12)
        case (.models, .regular):
            WidgetListDensityGeometry(rowHeight: 28, rowSpacing: 3, moreRowHeight: 12)
        case (_, .compact):
            WidgetListDensityGeometry(rowHeight: 13, rowSpacing: 1, moreRowHeight: 11)
        case (_, .summary):
            WidgetListDensityGeometry(rowHeight: 11, rowSpacing: 1, moreRowHeight: 11)
        }
    }

    static func plan(itemCount: Int, availableHeight: CGFloat, kind: WidgetListKind) -> WidgetListLayoutPlan {
        let count = max(0, itemCount)
        let height = max(0, availableHeight)

        for density in [WidgetContentDensity.regular, .compact, .summary] {
            let candidate = geometry(kind: kind, density: density)
            if candidate.fullHeight(itemCount: count) <= height {
                return WidgetListLayoutPlan(
                    density: density,
                    visibleCount: count,
                    hiddenCount: 0,
                    rowHeight: candidate.rowHeight,
                    rowSpacing: candidate.rowSpacing,
                    moreRowHeight: candidate.moreRowHeight
                )
            }
        }

        let summary = geometry(kind: kind, density: .summary)
        let rowStride = summary.rowHeight + summary.rowSpacing
        let availableForRows = max(0, height - summary.moreRowHeight - summary.rowSpacing)
        let capacity = rowStride > 0 ? Int(floor((availableForRows + summary.rowSpacing) / rowStride)) : 0
        let visibleCount = min(max(0, capacity), max(0, count - 1))
        return WidgetListLayoutPlan(
            density: .summary,
            visibleCount: visibleCount,
            hiddenCount: count - visibleCount,
            rowHeight: summary.rowHeight,
            rowSpacing: summary.rowSpacing,
            moreRowHeight: summary.moreRowHeight
        )
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

    var activeDays: Int {
        cells.filter { !$0.isFuture && $0.intensity > 0 }.count
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
        spacing: CGFloat
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
            allowsVerticalOverflow: false
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
        allowsVerticalOverflow: Bool
    ) -> WidgetHeatmapLayout {
        let normalizedSpacing = max(0, spacing)
        let normalizedMaxWeeks = max(0, maxWeeks)
        guard normalizedMaxWeeks > 0, availableSize.width > 0, availableSize.height > 0 else {
            return empty(spacing: normalizedSpacing)
        }

        var values: [Date: WidgetActivityDay] = [:]
        for day in days {
            guard let date = parse(day.date) else { continue }
            let existing = values[date]
            values[date] = WidgetActivityDay(
                date: day.date,
                intensity: max(existing?.intensity ?? 0, min(4, max(0, day.intensity))),
                totalTokens: max(existing?.totalTokens ?? 0, day.totalTokens)
            )
        }
        guard let earliest = values.keys.min() else { return empty(spacing: normalizedSpacing) }

        let reference = calendar.startOfDay(for: referenceDate)
        let referenceSunday = sunday(for: reference)
        let earliestSunday = sunday(for: min(earliest, reference))
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
                referenceSunday: referenceSunday
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
            referenceSunday: referenceSunday
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
        referenceSunday: Date
    ) -> WidgetHeatmapLayout {
        let gridStart = calendar.date(byAdding: .day, value: -(weekCount - 1) * 7, to: referenceSunday) ?? referenceSunday
        var cells: [WidgetHeatmapCell] = []
        cells.reserveCapacity(weekCount * 7)
        for offset in 0..<(weekCount * 7) {
            guard let date = calendar.date(byAdding: .day, value: offset, to: gridStart) else { continue }
            let isFuture = date > reference
            let activityDay = values[date]
            cells.append(WidgetHeatmapCell(
                date: format(date),
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

    private static func sunday(for date: Date) -> Date {
        let weekday = calendar.component(.weekday, from: date)
        return calendar.date(byAdding: .day, value: -(weekday - 1), to: date) ?? date
    }

    private static func parse(_ value: String) -> Date? {
        let parts = value.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4,
              parts[1].count == 2,
              parts[2].count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2]),
              let date = calendar.date(from: DateComponents(year: year, month: month, day: day)),
              format(date) == value else { return nil }
        return date
    }

    private static func format(_ date: Date) -> String {
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

    private static var calendar: Calendar = {
        var value = Calendar(identifier: .gregorian)
        value.locale = Locale(identifier: "en_US_POSIX")
        value.timeZone = TimeZone(secondsFromGMT: 0)!
        value.firstWeekday = 1
        return value
    }()
}

struct WidgetViewModel: Equatable {
    let page: WidgetPage
    let title: String
    let primaryValue: String
    let secondaryValue: String
    let rows: [String]

    static func make(snapshot: WidgetSnapshot, page: WidgetPage, layout: WidgetLayout) -> WidgetViewModel {
        switch page {
        case .overview:
            return WidgetViewModel(
                page: page,
                title: snapshot.overview.currentPeriod.uppercased(),
                primaryValue: WidgetFormat.tokens(snapshot.overview.totalTokens, style: snapshot.presentation.numberStyle),
                secondaryValue: snapshot.presentation.showCost ? WidgetFormat.cost(snapshot.overview.costUsd, presentation: snapshot.presentation) : "",
                rows: []
            )
        case .quota:
            let provider = snapshot.quota.first
            return WidgetViewModel(
                page: page,
                title: provider.map { WidgetFormat.provider($0.provider) } ?? WidgetL10n.text("Quota"),
                primaryValue: provider.map(WidgetFormat.quotaValue) ?? WidgetL10n.text("Not configured"),
                secondaryValue: provider?.windows.first?.resetsAt.map(WidgetFormat.reset) ?? "",
                rows: snapshot.quota.dropFirst().map {
                    "\(WidgetFormat.provider($0.provider)) · \(WidgetFormat.quotaValue($0))"
                }
            )
        case .models:
            let models = snapshot.models
            return WidgetViewModel(
                page: page,
                title: WidgetL10n.text("Models"),
                primaryValue: models.first?.displayName ?? WidgetL10n.text("No model data"),
                secondaryValue: models.first.map { "\(WidgetFormat.tokens($0.totalTokens, style: snapshot.presentation.numberStyle)) · \(Int($0.sharePercent.rounded()))%" } ?? "",
                rows: models.dropFirst().map { "\($0.displayName) · \(Int($0.sharePercent.rounded()))%" }
            )
        case .activity:
            return WidgetViewModel(
                page: page,
                title: snapshot.activity.currentPeriod.uppercased(),
                primaryValue: "\(snapshot.activity.activeDays)",
                secondaryValue: WidgetL10n.text("Active days"),
                rows: []
            )
        case .trend:
            return WidgetViewModel(
                page: page,
                title: WidgetL10n.text("Trend"),
                primaryValue: WidgetFormat.tokens(snapshot.trend.currentTokens, style: snapshot.presentation.numberStyle),
                secondaryValue: snapshot.trend.startDate.flatMap { start in snapshot.trend.endDate.map { "\(start) – \($0)" } } ?? WidgetL10n.text("No trend data"),
                rows: [WidgetL10n.format("Peak · %@", WidgetFormat.tokens(snapshot.trend.peakTokens, style: snapshot.presentation.numberStyle))]
            )
        }
    }
}

enum WidgetFormat {
    static func tokens(_ value: Int, style: String = "compact") -> String {
        guard style == "compact" else { return value.formatted(.number.grouping(.automatic)) }
        switch value {
        case 1_000_000_000...: return String(format: "%.1fB", Double(value) / 1_000_000_000)
        case 1_000_000...: return String(format: "%.1fM", Double(value) / 1_000_000)
        case 1_000...: return String(format: "%.1fK", Double(value) / 1_000)
        default: return value.formatted()
        }
    }

    static func cost(_ usd: Double, presentation: WidgetPresentation) -> String {
        let converted = usd * presentation.currencyRate
        return "\(presentation.currencySymbol)\(String(format: "%.2f", converted))"
    }

    static func provider(_ value: String) -> String {
        switch value.lowercased() {
        case "codex": "Codex"
        case "claude": "Claude"
        case "antigravity": "Antigravity"
        case "opencode": "OpenCode"
        case "deepseek": "DeepSeek"
        case "minimax": "MiniMax"
        case "mimo": "MiMo"
        case "copilot": "Copilot"
        case "zai", "zaiteam": "Z.ai"
        case "volcengine": "Volcengine"
        case "qoder": "Qoder"
        case "kimi": "Kimi"
        case "ollama": "Ollama"
        default: value.capitalized
        }
    }

    static func quotaValue(_ provider: WidgetQuotaProvider) -> String {
        if let balance = provider.balance, balance.amount.isFinite {
            let symbol = switch balance.currency.uppercased() {
            case "CNY": "¥"
            case "USD": "$"
            case "TWD": "NT$"
            case "HKD": "HK$"
            default: "\(balance.currency.uppercased()) "
            }
            let amount = String(
                format: "%.2f",
                locale: Locale(identifier: "en_US_POSIX"),
                balance.amount
            )
            return WidgetL10n.format("%@ left", "\(symbol)\(amount)")
        }
        if let remaining = provider.windows.first?.remainingPercent {
            return WidgetL10n.format("%lld%% left", Int(remaining.rounded()))
        }
        return provider.displayStatus
    }

    static func reset(_ date: Date) -> String {
        let seconds = max(0, date.timeIntervalSinceNow)
        let days = Int(seconds / 86_400)
        let hours = Int(seconds.truncatingRemainder(dividingBy: 86_400) / 3_600)
        return days > 0
            ? WidgetL10n.format("Reset in %lldd %lldh", days, hours)
            : WidgetL10n.format("Reset in %lldh", hours)
    }
}
