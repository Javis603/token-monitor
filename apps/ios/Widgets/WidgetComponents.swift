import SwiftUI
import WidgetKit

/// Resolved ink for one render: wallpaper-aware primary/secondary plus the
/// data accent (primary under accented rendering). Passed through the
/// environment so layouts never thread it.
struct WidgetInkColors {
    let primary: Color
    let secondary: Color
    let accent: Color
}

extension EnvironmentValues {
    @Entry var widgetInk = WidgetInkColors(
        primary: .primary,
        secondary: .secondary,
        accent: WidgetPresentation.accent
    )
}

// MARK: - Header

/// Every home-family widget's top row: a 13pt glyph and quiet caption title
/// leading, freshness trailing (stale badge, or a compact "5m" age when the
/// user shows update time).
struct WidgetHeader: View {
    @Environment(\.widgetInk) private var ink
    let entry: TokenMonitorWidgetEntry
    /// Overrides for the large limits widget, which titles itself "AI Limits".
    var title: LocalizedStringKey? = nil
    var systemImage: String? = nil
    var planLabel: String? = nil
    var isCompact = false

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            glyph
            Text(resolvedTitle)
                .font(.caption.weight(.semibold))
                .foregroundStyle(ink.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .layoutPriority(1)
            if let planLabel, !planLabel.isEmpty, !isCompact {
                Text(verbatim: planLabel)
                    .font(.caption)
                    .foregroundStyle(ink.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            trailing
        }
        .widgetAccentable()
        .accessibilityElement(children: .combine)
    }

    private var resolvedTitle: LocalizedStringKey {
        if let title { return title }
        switch entry.content {
        case "limits":
            return LocalizedStringKey(
                entry.preferredLimit.map { WidgetPresentation.displayName(for: $0.providerID) } ?? "AI Limits"
            )
        case "activity":
            return "Activity"
        default:
            return entry.periodTitle
        }
    }

    @ViewBuilder private var glyph: some View {
        if let systemImage {
            Image(systemName: systemImage)
                .font(.system(size: 13))
                .foregroundStyle(ink.secondary)
        } else {
            switch entry.content {
            case "limits":
                ActivityMark(providerID: entry.preferredLimit?.providerID, size: 13)
                    .foregroundStyle(ink.secondary)
            case "activity":
                Image(systemName: "square.grid.3x3.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(ink.secondary)
            default:
                ActivityMark(providerID: nil, size: 13)
                    .foregroundStyle(ink.secondary)
            }
        }
    }

    @ViewBuilder private var trailing: some View {
        if entry.isStale {
            HStack(spacing: 4) {
                Image(systemName: "clock.badge.exclamationmark")
                if !isCompact {
                    Text("Data may be out of date")
                        .lineLimit(1)
                }
            }
            .font(.caption2)
            .foregroundStyle(ink.secondary)
            .accessibilityLabel("Data may be out of date")
        } else if entry.showsUpdateTime {
            if let dataDate = entry.dataDate {
                Text(verbatim: WidgetPresentation.compactAge(since: dataDate, now: entry.date))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(ink.secondary)
                    .accessibilityLabel(WidgetPresentation.updateDescription(for: dataDate, relativeTo: entry.date))
            } else {
                Text("Not updated")
                    .font(.caption2)
                    .foregroundStyle(ink.secondary)
            }
        }
    }
}

// MARK: - Empty state

/// Σ mark, headline and caption, vertically centred — keeps "missing" and
/// "measured zero" visually distinct.
struct WidgetEmptyState: View {
    @Environment(\.widgetInk) private var ink
    let noSnapshot: Bool

    var body: some View {
        VStack(spacing: 8) {
            ActivityMark(providerID: nil, size: 22)
                .foregroundStyle(ink.secondary)
            VStack(spacing: 3) {
                Text(noSnapshot
                     ? LocalizedStringKey("Open Token Monitor")
                     : LocalizedStringKey("No data"))
                    .font(.headline)
                    .foregroundStyle(ink.primary)
                Text(noSnapshot
                     ? LocalizedStringKey("Connect to your Hub to fill this widget.")
                     : LocalizedStringKey("Refresh your reporting devices."))
                    .font(.caption)
                    .foregroundStyle(ink.secondary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Daily bars

/// Rounded-rect bars for the period's trailing days: today at accent,
/// history neutral ink at 0.22, a measured zero a 2pt stub at ink 0.18, and
/// an absent day a lighter stub at 0.07 — missing never reads as zero.
struct WidgetDailyBars: View {
    @Environment(\.widgetInk) private var ink
    let bars: [WidgetActivityModel.Bar]
    var height: CGFloat = 28

    private var spacing: CGFloat { bars.count > 14 ? 2 : 4 }

    var body: some View {
        HStack(alignment: .bottom, spacing: spacing) {
            ForEach(bars) { bar in
                GeometryReader { proxy in
                    let width = min(14, proxy.size.width * 0.6)
                    RoundedRectangle(cornerRadius: min(2.5, width / 2), style: .continuous)
                        .fill(color(for: bar))
                        .frame(width: width, height: barHeight(for: bar))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                }
            }
        }
        .frame(height: height, alignment: .bottom)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(summary)
    }

    private func barHeight(for bar: WidgetActivityModel.Bar) -> CGFloat {
        guard bar.tokens != nil else { return 2 }
        guard let tokens = bar.tokens, tokens > 0 else { return 2 }
        return max(3, height * bar.fraction)
    }

    private func color(for bar: WidgetActivityModel.Bar) -> Color {
        guard let tokens = bar.tokens else { return ink.primary.opacity(0.07) }
        guard tokens > 0 else { return ink.primary.opacity(0.18) }
        let isToday = WidgetActivityModel.calendar.isDateInToday(bar.date)
        return isToday ? ink.accent : ink.primary.opacity(0.22)
    }

    private var summary: String {
        let peak = bars.compactMap(\.tokens).max() ?? 0
        return String(
            format: String(localized: "Last %lld days, peak %@"),
            Int64(bars.count),
            WidgetPresentation.tokens(peak)
        )
    }
}

// MARK: - Share meter

/// 3pt capsule under a tool/model row: the row's share of period tokens,
/// accent fill on a quiet ink track.
struct WidgetShareMeter: View {
    @Environment(\.widgetInk) private var ink
    let fraction: Double?
    var height: CGFloat = 3

    var body: some View {
        Capsule()
            .fill(ink.primary.opacity(0.12))
            .overlay(alignment: .leading) {
                if let fraction {
                    GeometryReader { proxy in
                        Capsule()
                            .fill(ink.accent)
                            .frame(width: max(height, fraction * proxy.size.width))
                    }
                }
            }
            .frame(height: height)
            .widgetAccentable()
            .accessibilityHidden(true)
    }
}

// MARK: - Stat

/// ActivityCaption-style label over a semibold reading; "—" for unknown.
struct WidgetStat: View {
    @Environment(\.widgetInk) private var ink
    let title: LocalizedStringKey
    let value: String
    var valueFont: Font = .subheadline.weight(.semibold)

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.caption2.weight(.medium))
                .textCase(.uppercase)
                .kerning(0.5)
                .foregroundStyle(ink.secondary)
                .lineLimit(1)
            Text(verbatim: value)
                .font(valueFont)
                .monospacedDigit()
                .foregroundStyle(ink.primary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Breakdown row

/// Icon + name + compact value; provider artwork desaturates in accented mode.
struct WidgetBreakdownRow: View {
    @Environment(\.widgetInk) private var ink
    let item: TokenMonitorSharedPayload.Breakdown
    let models: Bool
    let locale: Locale
    var share: Double? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Image(models
                      ? WidgetPresentation.modelAssetName(for: item.id)
                      : WidgetPresentation.assetName(for: item.id))
                    .resizable()
                    .widgetAccentedRenderingMode(.accentedDesaturated)
                    .scaledToFit()
                    .frame(width: 14, height: 14)
                    .accessibilityHidden(true)
                Text(verbatim: models ? item.id : WidgetPresentation.displayName(for: item.id))
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(verbatim: WidgetPresentation.tokens(item.value, locale: locale))
                    .monospacedDigit()
                    .foregroundStyle(ink.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .font(.caption)
            if let share {
                WidgetShareMeter(fraction: share)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

// MARK: - Limit window column

/// ActivityWindowColumn's twin for snapshot windows: label leading secondary,
/// value trailing semibold on one baseline, quota-tinted meter, reset caption.
struct WidgetWindowColumn: View {
    @Environment(\.widgetInk) private var ink
    let window: TokenMonitorSharedPayload.LimitWindow
    let providerID: String?
    let now: Date
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(LocalizedStringKey(window.label))
                    .foregroundStyle(ink.secondary)
                Spacer(minLength: 4)
                Text(verbatim: valueText)
                    .fontWeight(.semibold)
            }
            .font(.caption.monospacedDigit())
            .lineLimit(1)
            meter
            Text(verbatim: resetText ?? " ")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(ink.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    /// Credits windows have no percent; an invisible track keeps column
    /// alignment.
    @ViewBuilder private var meter: some View {
        if let fraction = WidgetPresentation.fraction(window.remainingPercent, total: 100) {
            ActivityMeter(
                fraction: fraction,
                tint: ActivityPalette.quotaTint(providerID)
            )
        } else {
            Capsule()
                .fill(.clear)
                .frame(height: 6)
        }
    }

    /// "82% left" in fixed desktop English, or the provider-currency amount.
    var valueText: String {
        if let fraction = WidgetPresentation.fraction(window.remainingPercent, total: 100) {
            return WidgetPresentation.remaining(fraction * 100, locale: WidgetPresentation.desktopQuotaLocale)
        }
        if let amount = window.amount, amount.isFinite {
            guard let currency = window.currency, !currency.isEmpty else {
                return amount.formatted(
                    .number.precision(.fractionLength(0...2)).locale(locale)
                )
            }
            return WidgetPresentation.currency(
                amount, sourceCode: currency, displayCode: currency, locale: locale
            )
        }
        return "—"
    }

    /// "82%" (or the credits amount) — the headline without the "left" tail.
    var shortValueText: String {
        if let fraction = WidgetPresentation.fraction(window.remainingPercent, total: 100) {
            return WidgetPresentation.percent(fraction * 100, locale: WidgetPresentation.desktopQuotaLocale)
        }
        return valueText
    }

    var isPercent: Bool {
        WidgetPresentation.fraction(window.remainingPercent, total: 100) != nil
    }

    var fraction: Double? {
        WidgetPresentation.fraction(window.remainingPercent, total: 100)
    }

    var resetText: String? {
        window.resetAt.map { WidgetPresentation.resetDescription(to: $0, now: now) }
    }
}

// MARK: - Activity grid

/// GitHub-style grid: week columns, Sunday-first rows, ending at the current
/// week. Level 1–4 readings are accent 0.35/0.55/0.78/1.0, a measured zero is
/// ink 0.10, absent 0.05, and future cells are not drawn.
struct WidgetActivityGrid: View {
    @Environment(\.widgetInk) private var ink
    let grid: WidgetActivityModel.Grid
    let cell: CGFloat
    var gap: CGFloat = 3
    var monthLabels = false
    let locale: Locale

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if monthLabels { monthRow }
            HStack(alignment: .top, spacing: gap) {
                ForEach(Array(grid.columns.enumerated()), id: \.offset) { _, column in
                    VStack(spacing: gap) {
                        ForEach(Array(column.cells.enumerated()), id: \.offset) { _, cell in
                            RoundedRectangle(cornerRadius: max(1, self.cell * 0.22), style: .continuous)
                                .fill(color(for: cell))
                                .frame(width: self.cell, height: self.cell)
                        }
                    }
                }
            }
            // The grid ends at the current week — anchor it to the trailing
            // edge so leftover space lands on the oldest weeks.
            .frame(maxWidth: .infinity, alignment: .trailing)
            .widgetAccentable()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(summary)
        }
    }

    private func color(for cell: WidgetActivityModel.Cell) -> Color {
        if cell.isFuture { return .clear }
        guard let tokens = cell.tokens else { return ink.primary.opacity(0.05) }
        guard tokens > 0 else { return ink.primary.opacity(0.10) }
        let opacities = [0.0, 0.40, 0.55, 0.78, 1.0]
        return ink.accent.opacity(opacities[min(4, max(1, cell.level))])
    }

    /// A short month label over the first column of each month, trailing
    /// aligned like the columns it labels.
    private var monthRow: some View {
        HStack(alignment: .top, spacing: gap) {
            ForEach(Array(grid.columns.enumerated()), id: \.offset) { index, column in
                let label = monthLabel(at: index)
                Text(verbatim: label)
                    .font(.caption2)
                    .foregroundStyle(ink.secondary)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(width: cell, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityHidden(true)
    }

    private func monthLabel(at index: Int) -> String {
        let columns = grid.columns
        guard columns.indices.contains(index) else { return "" }
        let calendar = WidgetActivityModel.calendar
        let month = calendar.component(.month, from: columns[index].firstDate)
        if index > 0,
           calendar.component(.month, from: columns[index - 1].firstDate) == month {
            return ""
        }
        return columns[index].firstDate
            .formatted(.dateTime.month(.abbreviated).locale(locale))
    }

    private var summary: String {
        String(
            format: String(localized: "Last %lld weeks, %lld active days, peak %@"),
            Int64(grid.columns.count),
            Int64(grid.activeDays),
            WidgetPresentation.tokens(grid.peak, locale: locale)
        )
    }
}
