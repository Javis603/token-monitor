import SwiftUI
import WidgetKit

struct ActivityHeatmap: View {
    let layout: WidgetHeatmapLayout
    let family: WidgetFamilyScope?
    let selectedDate: String?

    var body: some View {
        if layout.cells.isEmpty {
            EmptyView()
        } else {
            Grid(horizontalSpacing: layout.spacing, verticalSpacing: layout.spacing) {
                ForEach(0..<7, id: \.self) { weekday in
                    GridRow {
                        ForEach(0..<layout.weekCount, id: \.self) { week in
                            if let cell = layout.cell(week: week, weekday: weekday) {
                                if let family, cell.isSelectable {
                                    Button(intent: SelectActivityDayIntent(family: family, date: cell.date)) {
                                        ActivityHeatmapCell(
                                            cell: cell,
                                            width: layout.cellWidth,
                                            height: layout.cellHeight,
                                            color: activityColor(cell.intensity),
                                            isSelected: selectedDate == cell.date
                                        )
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityLabel(WidgetL10n.format("%@, %lld tokens", cell.date, cell.totalTokens))
                                    .accessibilityHint(selectedDate == cell.date ? WidgetL10n.text("Deselect") : WidgetL10n.text("Show usage for this day"))
                                } else {
                                    ActivityHeatmapCell(
                                        cell: cell,
                                        width: layout.cellWidth,
                                        height: layout.cellHeight,
                                        color: activityColor(cell.intensity),
                                        isSelected: false
                                    )
                                    .allowsHitTesting(false)
                                    .accessibilityHidden(!cell.isSelectable)
                                }
                            }
                        }
                    }
                }
            }
            .frame(width: layout.renderedWidth, height: layout.renderedHeight, alignment: .topLeading)
            .accessibilityLabel(WidgetL10n.text("Activity heatmap"))
        }
    }

    private func activityColor(_ intensity: Int) -> Color {
        switch max(0, min(4, intensity)) {
        case 0: .white.opacity(0.03)
        case 1: Color(red: 90 / 255, green: 170 / 255, blue: 1).opacity(0.18)
        case 2: Color(red: 120 / 255, green: 190 / 255, blue: 1).opacity(0.45)
        case 3: Color(red: 150 / 255, green: 210 / 255, blue: 1).opacity(0.8)
        default: Color(red: 180 / 255, green: 230 / 255, blue: 1)
        }
    }
}

private struct ActivityHeatmapCell: View {
    let cell: WidgetHeatmapCell
    let width: CGFloat
    let height: CGFloat
    let color: Color
    let isSelected: Bool

    private var cornerRadius: CGFloat {
        min(1.5, min(width, height) / 3)
    }

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius)
            .fill(cell.isFuture ? Color.clear : color)
            .frame(width: width, height: height)
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: cornerRadius)
                        .strokeBorder(.primary, lineWidth: 2)
                }
            }
    }
}

struct MediumActivityModule: View {
    let snapshot: WidgetSnapshot
    let referenceDate: Date
    let selectedActivityDate: String?
    let availableSize: CGSize

    var body: some View {
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: snapshot.activity.days,
            referenceDate: referenceDate,
            availableSize: CGSize(width: availableSize.width, height: max(60, availableSize.height - 42)),
            maxWeeks: WidgetActivityCoverage.maxWeeks(for: .medium),
            minCellSize: 5.5,
            maxCellSize: 9.5,
            spacing: 2.5
        )
        ZStack {
            WidgetRefreshBackground()
            VStack(alignment: .leading, spacing: 8) {
                ActivityHeatmapWithMonthLabels(layout: layout, family: .medium, selectedDate: selectedActivityDate)
                    .frame(maxWidth: .infinity, alignment: .center)
                WidgetRefreshButton {
                    ActivitySummaryLabel(
                        snapshot: snapshot,
                        selectedDate: selectedActivityDate,
                        fallback: overviewSummary,
                        includesCost: true
                    )
                    .font(.caption.weight(.medium))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }

    private var overviewSummary: String {
        let tokens = snapshot.activity.days.reduce(0) { $0 + $1.totalTokens }
        let tokenText = WidgetFormat.tokens(tokens, style: "compact", presentation: snapshot.presentation)
        return WidgetL10n.format("%@ tokens · %lld active days", tokenText, snapshot.activity.activeDays)
    }
}

struct DashboardActivityModule: View {
    let snapshot: WidgetSnapshot
    let referenceDate: Date
    let selectedActivityDate: String?
    let availableWidth: CGFloat

    var body: some View {
        let layout = WidgetHeatmapLayoutCalculator.make(
            days: snapshot.activity.days,
            referenceDate: referenceDate,
            availableSize: CGSize(width: availableWidth, height: 64),
            maxWeeks: WidgetActivityCoverage.maxWeeks(for: .large),
            minCellSize: 5,
            maxCellSize: 7.5,
            spacing: 2.25
        )
        ZStack(alignment: .topLeading) {
            WidgetRefreshBackground()
            VStack(alignment: .leading, spacing: 9) {
                WidgetRefreshButton {
                    ModuleTitle(WidgetL10n.text("Activity"))
                }
                ActivityHeatmapWithMonthLabels(layout: layout, family: .large, selectedDate: selectedActivityDate)
                    .frame(maxWidth: .infinity, alignment: .leading)
                WidgetRefreshButton {
                    ActivitySummaryLabel(
                        snapshot: snapshot,
                        selectedDate: selectedActivityDate,
                        fallback: WidgetL10n.format("%lld active days", snapshot.activity.activeDays),
                        includesCost: false
                    )
                    .font(.system(size: WidgetDesignTokens.dashboardDetailSize, weight: .medium))
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct ActivitySummaryLabel: View {
    let snapshot: WidgetSnapshot
    let selectedDate: String?
    let fallback: String
    let includesCost: Bool

    var body: some View {
        Text(summary)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.74)
            .accessibilityLabel(summary)
    }

    private var summary: String {
        guard let day = WidgetActivitySelection.selectedDay(
            in: snapshot.activity.days,
            selectedDate: selectedDate
        ) else { return fallback }

        let date = WidgetActivityDate.date(from: day.date)
        let dateLabel = date?.formatted(.dateTime.month(.abbreviated).day()) ?? day.date
        let tokens = WidgetFormat.tokens(day.totalTokens, style: "compact", presentation: snapshot.presentation)
        let usage = WidgetL10n.format("%@ · %@ tokens", dateLabel, tokens)
        guard includesCost, snapshot.presentation.showCost else { return usage }
        return WidgetL10n.format(
            "%@ · %@ tokens · %@",
            dateLabel,
            tokens,
            WidgetFormat.cost(day.costUsd, presentation: snapshot.presentation)
        )
    }
}

private struct ActivityHeatmapWithMonthLabels: View {
    let layout: WidgetHeatmapLayout
    let family: WidgetFamilyScope
    let selectedDate: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ActivityHeatmap(layout: layout, family: family, selectedDate: selectedDate)
            HeatmapMonthLabels(layout: layout)
        }
        .frame(width: layout.renderedWidth, alignment: .leading)
    }
}

private struct HeatmapMonthLabels: View {
    let layout: WidgetHeatmapLayout

    var body: some View {
        ZStack(alignment: .leading) {
            ForEach(markers) { marker in
                Text(marker.title)
                    .font(.system(size: 8, weight: .medium))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .offset(x: min(markerOffset(marker.week), max(0, layout.renderedWidth - 22)))
            }
        }
        .frame(width: layout.renderedWidth, height: 10, alignment: .leading)
        .clipped()
        .accessibilityHidden(true)
    }

    private var markers: [HeatmapMonthMarker] {
        var result: [HeatmapMonthMarker] = []
        var previousMonth: String?

        for week in 0..<layout.weekCount {
            let monthKeys = (0..<7).compactMap { weekday in
                layout.cell(week: week, weekday: weekday)?.date.split(separator: "-").prefix(2).joined(separator: "-")
            }
            let monthKey = previousMonth.flatMap { previous in
                monthKeys.first(where: { $0 != previous })
            } ?? monthKeys.first
            guard let monthKey else { continue }
            if monthKey != previousMonth {
                result.append(HeatmapMonthMarker(week: week, title: monthTitle(monthKey)))
                previousMonth = monthKey
            }
        }
        return result
    }

    private func markerOffset(_ week: Int) -> CGFloat {
        CGFloat(week) * (layout.cellWidth + layout.spacing)
    }

    private func monthTitle(_ key: String) -> String {
        let parts = key.split(separator: "-")
        guard parts.count == 2,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let date = Calendar.current.date(from: DateComponents(year: year, month: month, day: 1))
        else { return key }
        return date.formatted(.dateTime.month(.abbreviated))
    }
}

private struct HeatmapMonthMarker: Identifiable {
    let week: Int
    let title: String

    var id: Int { week }
}
