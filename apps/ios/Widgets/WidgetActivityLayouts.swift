import SwiftUI
import WidgetKit

/// Desktop's compact calendar cells and month captions, adapted to the
/// widget's bounded canvas. Statistics never dictate the chart's height.
struct WidgetActivityView: View {
    @Environment(\.widgetInk) private var ink
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: TokenMonitorWidgetEntry
    let family: WidgetFamily

    private var accessible: Bool { typeSize.isAccessibilitySize }
    private var days: [TokenMonitorSharedPayload.Day] { entry.days }
    private var todayText: String {
        guard let today = WidgetActivityModel.today(days, now: entry.date), today.tokens.isFinite else { return "—" }
        return WidgetPresentation.tokens(today.tokens, locale: entry.locale)
    }
    private var last7Text: String {
        guard let total = WidgetActivityModel.last7Total(days, now: entry.date) else { return "—" }
        return WidgetPresentation.tokens(total, locale: entry.locale)
    }
    private var streakText: String { "\(WidgetActivityModel.streak(days, now: entry.date))d" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(entry: entry, isCompact: family == .systemSmall)
            if accessible {
                WidgetStat(title: "Today", value: todayText)
                if family != .systemSmall { WidgetStat(title: "Last 7 days", value: last7Text) }
                Spacer(minLength: 0)
            } else {
                switch family {
                case .systemLarge: large
                case .systemMedium where entry.preferences.widgetActivityLayout == "summary": summary
                default: chart
                }
            }
        }
    }

    private var chart: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: todayText)
                    .font(.title3.weight(.semibold)).monospacedDigit()
                    .lineLimit(1).minimumScaleFactor(0.8)
                Text("Today").font(.caption2).foregroundStyle(ink.secondary)
                if family == .systemMedium {
                    Spacer(minLength: 8)
                    Text("Last 7 days").font(.caption2).foregroundStyle(ink.secondary)
                    Text(verbatim: last7Text).font(.caption.weight(.semibold)).monospacedDigit()
                }
            }
            grid
        }
    }

    private var summary: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 12) {
                WidgetStat(title: "Today", value: todayText)
                WidgetStat(title: "Last 7 days", value: last7Text)
            }
            .frame(maxWidth: 90, alignment: .leading)
            grid
        }
    }

    private var grid: some View {
        GeometryReader { proxy in
            let geometry = WidgetActivityModel.gridGeometry(
                width: proxy.size.width, height: proxy.size.height - 17,
                cellCap: family == .systemSmall ? 9 : 10
            )
            if geometry.weeks > 0 {
                WidgetActivityGrid(
                    grid: WidgetActivityModel.grid(days, weekCount: geometry.weeks, now: entry.date),
                    cell: geometry.cell, monthLabels: true, locale: entry.locale
                )
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Two chronological half-year strips keep the Desktop calendar density
    /// on the taller family instead of inflating each day into a large tile.
    private var large: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 16) {
                WidgetStat(title: "Today", value: todayText)
                WidgetStat(title: "Last 7 days", value: last7Text)
                WidgetStat(title: "Streak", value: streakText)
            }
            GeometryReader { proxy in
                let gap = 2.0
                let availableHeight = max(0, (proxy.size.height - 16) / 2 - 17)
                let cell = min(11, max(0, (proxy.size.width - 25 * gap) / 26), max(0, (availableHeight - 6 * gap) / 7))
                let full = WidgetActivityModel.grid(days, weekCount: 52, now: entry.date)
                VStack(alignment: .leading, spacing: 16) {
                    calendarStrip(Array(full.columns.prefix(26)), cell: cell)
                    calendarStrip(Array(full.columns.suffix(26)), cell: cell)
                }
            }
            HStack(spacing: 5) {
                Text("Less").font(.caption2)
                ForEach(0..<5, id: \.self) { level in
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(level == 0 ? ink.primary.opacity(0.10) : ink.accent.opacity([0, 0.18, 0.45, 0.8, 1][level]))
                        .frame(width: 8, height: 8)
                }
                Text("More").font(.caption2)
                Spacer(minLength: 0)
                Text("Tokens").font(.caption2)
            }
            .foregroundStyle(ink.secondary)
            .accessibilityHidden(true)
        }
    }

    private func calendarStrip(_ columns: [WidgetActivityModel.Column], cell: CGFloat) -> some View {
        let cells = columns.flatMap(\.cells)
        let grid = WidgetActivityModel.Grid(
            columns: columns,
            activeDays: cells.count { ($0.tokens ?? 0) > 0 && !$0.isFuture },
            visibleDays: cells.count { !$0.isFuture },
            peak: cells.compactMap(\.tokens).max() ?? 0
        )
        return WidgetActivityGrid(grid: grid, cell: cell, monthLabels: true, locale: entry.locale)
    }
}
