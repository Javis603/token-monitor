import SwiftUI
import WidgetKit

/// Activity content across home families: today's reading plus a
/// GitHub-style week grid — Today / Last 7 days / Streak stats at larger
/// sizes, month labels and a Less→More legend on large.
struct WidgetActivityView: View {
    @Environment(\.widgetInk) private var ink
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: TokenMonitorWidgetEntry
    let family: WidgetFamily

    private var accessible: Bool { typeSize.isAccessibilitySize }
    private var days: [TokenMonitorSharedPayload.Day] { entry.days }

    private var todayText: String {
        guard let today = WidgetActivityModel.today(days, now: entry.date),
              today.tokens.isFinite else { return "—" }
        return WidgetPresentation.tokens(today.tokens, locale: entry.locale)
    }

    private var last7Text: String {
        guard let total = WidgetActivityModel.last7Total(days, now: entry.date) else { return "—" }
        return WidgetPresentation.tokens(total, locale: entry.locale)
    }

    private var streakText: String {
        "\(WidgetActivityModel.streak(days, now: entry.date))d"
    }

    var body: some View {
        switch family {
        case .systemMedium: medium
        case .systemLarge: large
        default: small
        }
    }

    // MARK: Small — today reading + grid

    private var small: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(entry: entry, isCompact: true)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(verbatim: todayText)
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
                    .widgetAccentable()
                if todayText != "—" {
                    Text("Today")
                        .font(.caption)
                        .foregroundStyle(ink.secondary)
                }
            }
            if !accessible {
                grid(cap: 16)
            } else {
                Spacer(minLength: 0)
            }
        }
    }

    // MARK: Medium — stat column beside the grid

    private var medium: some View {
        VStack(alignment: .leading, spacing: 10) {
            WidgetHeader(entry: entry)
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 12) {
                    WidgetStat(title: "Today", value: todayText)
                    WidgetStat(title: "Last 7 days", value: last7Text)
                    WidgetStat(title: "Streak", value: streakText)
                    Spacer(minLength: 0)
                }
                .frame(width: 96, alignment: .leading)
                if !accessible {
                    grid(cap: 16)
                }
            }
        }
    }

    // MARK: Large — stat row, month labels, grid, footer

    private var large: some View {
        VStack(alignment: .leading, spacing: 10) {
            WidgetHeader(entry: entry)
            HStack(alignment: .top, spacing: 16) {
                WidgetStat(title: "Today", value: todayText, valueFont: .title3.weight(.semibold))
                WidgetStat(title: "Last 7 days", value: last7Text, valueFont: .title3.weight(.semibold))
                WidgetStat(title: "Streak", value: streakText, valueFont: .title3.weight(.semibold))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 8)
            if !accessible {
                GeometryReader { proxy in
                    largeGrid(in: proxy.size)
                }
            } else {
                Spacer(minLength: 0)
            }
        }
    }

    private func largeGrid(in size: CGSize) -> some View {
        // Footer sits 10pt under the grid; the roomier 6pt gap fills most of
        // the spare height and two spacers split what is left so no band
        // grows past ~24pt.
        let gap = 9.0
        let reserved = 12.0 + 10.0 + 16.0
        let geometry = WidgetActivityModel.gridGeometry(
            width: size.width,
            height: size.height - reserved,
            gap: gap,
            cellCap: 24
        )
        let grid = WidgetActivityModel.grid(days, weekCount: geometry.weeks, now: entry.date)
        return VStack(alignment: .leading, spacing: 10) {
            // Cap the top spacer so the band under the stats stays tight;
            // the bottom spacer takes what is left.
            Spacer(minLength: 0)
                .frame(maxHeight: 24)
            WidgetActivityGrid(
                grid: grid,
                cell: geometry.cell,
                gap: gap,
                monthLabels: true,
                locale: entry.locale
            )
            footer(grid)
            Spacer(minLength: 0)
        }
    }

    private func footer(_ grid: WidgetActivityModel.Grid) -> some View {
        HStack(spacing: 6) {
            Text(String(
                format: String(localized: "Active days %lld of %lld", locale: entry.locale),
                Int64(grid.activeDays), Int64(grid.visibleDays)
            ))
            .font(.caption2)
            .foregroundStyle(ink.secondary)
            Spacer(minLength: 0)
            Text("Less")
                .font(.caption2)
                .foregroundStyle(ink.secondary)
            legendCells
            Text("More")
                .font(.caption2)
                .foregroundStyle(ink.secondary)
        }
        .accessibilityHidden(true)
    }

    private var legendCells: some View {
        HStack(spacing: 3) {
            RoundedRectangle(cornerRadius: 2, style: .continuous)
                .fill(ink.primary.opacity(0.05))
                .frame(width: 9, height: 9)
            ForEach(1...4, id: \.self) { level in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(ink.accent.opacity([0.0, 0.40, 0.55, 0.78, 1.0][level]))
                    .frame(width: 9, height: 9)
            }
        }
    }

    private func grid(cap: CGFloat) -> some View {
        GeometryReader { proxy in
            let geometry = WidgetActivityModel.gridGeometry(
                width: proxy.size.width,
                height: proxy.size.height,
                cellCap: cap
            )
            WidgetActivityGrid(
                grid: WidgetActivityModel.grid(days, weekCount: geometry.weeks, now: entry.date),
                cell: geometry.cell,
                locale: entry.locale
            )
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
