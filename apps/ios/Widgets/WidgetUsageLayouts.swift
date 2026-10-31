import SwiftUI
import WidgetKit

/// Usage content across home families: a dominant token reading, cost when
/// enabled, trailing daily bars, and tool/model attribution at larger sizes.
/// Accessibility text keeps only the main reading and its label.
struct WidgetUsageView: View {
    @Environment(\.widgetInk) private var ink
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: TokenMonitorWidgetEntry
    let family: WidgetFamily

    private var isSmall: Bool { family == .systemSmall }
    private var isMedium: Bool { family == .systemMedium }
    private var isLarge: Bool { family == .systemLarge }
    private var accessible: Bool { typeSize.isAccessibilitySize }

    private var usage: TokenMonitorSharedPayload.Usage { entry.usage }
    private var tokensText: String {
        WidgetPresentation.tokens(usage.tokens, locale: entry.locale)
    }
    private var costIsKnown: Bool {
        usage.costKnown != false && usage.cost.isFinite
    }
    private var costText: String {
        guard costIsKnown else { return "—" }
        return WidgetPresentation.currencyFromUSD(
            usage.cost, displayCode: entry.currencyCode, locale: entry.locale
        )
    }
    private var bars: [WidgetActivityModel.Bar] {
        WidgetActivityModel.bars(entry.days, period: entry.period, now: entry.date)
    }

    var body: some View {
        if isMedium { medium }
        else if isLarge { large }
        else { small }
    }

    // MARK: Small — Σ Today / reading / bars

    private var small: some View {
        VStack(alignment: .leading, spacing: 8) {
            WidgetHeader(entry: entry, isCompact: true)
            VStack(alignment: .leading, spacing: 2) {
                tokenValue(34)
                if entry.showsCost, !accessible {
                    costValue
                }
            }
            if accessible {
                Text("Tokens")
                    .font(.caption2)
                    .foregroundStyle(ink.secondary)
            }
            Spacer(minLength: 0)
            if !accessible {
                if bars.isEmpty {
                    if let tool = usage.tools.first {
                        WidgetBreakdownRow(item: tool, models: false, locale: entry.locale)
                    }
                } else {
                    WidgetDailyBars(bars: bars, height: 34)
                }
            }
        }
    }

    // MARK: Medium — reading + bars left, top tools right

    private var medium: some View {
        VStack(alignment: .leading, spacing: 10) {
            WidgetHeader(entry: entry)
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 2) {
                    tokenValue(36)
                    if entry.showsCost, !accessible {
                        costValue
                    }
                    if accessible {
                        Text("Tokens")
                            .font(.caption2)
                            .foregroundStyle(ink.secondary)
                    }
                    Spacer(minLength: 0)
                    if !accessible {
                        WidgetDailyBars(bars: bars, height: 26)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if !accessible, !usage.tools.isEmpty {
                    Link(destination: Self.overviewURL) {
                        toolsColumn
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// Up to 3 top tools, each with a 3pt share capsule of period tokens.
    private var toolsColumn: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(usage.tools.prefix(3)) { tool in
                WidgetBreakdownRow(
                    item: tool,
                    models: false,
                    locale: entry.locale,
                    share: share(of: tool)
                )
            }
        }
        .frame(width: 148, alignment: .leading)
    }

    private func share(of item: TokenMonitorSharedPayload.Breakdown) -> Double? {
        WidgetPresentation.fraction(item.value, total: usage.tokens)
    }

    // MARK: Large — hero, stats, 14-day bars, Tools | Models

    private var large: some View {
        VStack(alignment: .leading, spacing: 10) {
            WidgetHeader(entry: entry)
            VStack(alignment: .leading, spacing: 2) {
                tokenValue(42)
                if entry.showsCost, !accessible {
                    costValue
                }
            }
            if accessible {
                Text("Tokens")
                    .font(.caption2)
                    .foregroundStyle(ink.secondary)
                Spacer(minLength: 0)
            } else {
                statsRow
                let series = WidgetActivityModel.bars(entry.days, dayCount: 14, now: entry.date)
                VStack(alignment: .leading, spacing: 3) {
                    WidgetDailyBars(bars: series, height: 64)
                    HStack {
                        Text(verbatim: edgeLabel(series.first?.date))
                        Spacer(minLength: 0)
                        Text(lastLabel(for: series))
                    }
                    .font(.caption2)
                    .foregroundStyle(ink.secondary)
                    .accessibilityHidden(true)
                }
                HStack(alignment: .top, spacing: 16) {
                    Link(destination: Self.overviewURL) {
                        breakdownColumn("Tools", items: usage.tools, models: false)
                    }
                    .buttonStyle(.plain)
                    Link(destination: Self.overviewURL) {
                        breakdownColumn("Models", items: usage.models, models: true)
                    }
                    .buttonStyle(.plain)
                }
            }
            Spacer(minLength: 0)
        }
    }

    private var statsRow: some View {
        HStack(alignment: .top, spacing: 16) {
            WidgetStat(title: "Cache hit", value: cacheHitText)
            WidgetStat(title: "Output", value: outputText)
            WidgetStat(title: "Avg speed", value: speedText)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var cacheHitText: String {
        guard let percent = usage.cacheHitPercent else { return "—" }
        return WidgetPresentation.percent(percent, locale: entry.locale)
    }

    private var outputText: String {
        guard usage.outputTokens.isFinite else { return "—" }
        return WidgetPresentation.tokens(usage.outputTokens, locale: entry.locale)
    }

    private var speedText: String {
        guard usage.throughputKnown != false,
              let speed = usage.outputTokensPerSecond,
              speed.isFinite, speed > 0 else { return "—" }
        return speed.formatted(.number.precision(.fractionLength(0)).locale(entry.locale)) + " tok/s"
    }

    private func breakdownColumn(
        _ title: LocalizedStringKey,
        items: [TokenMonitorSharedPayload.Breakdown],
        models: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.caption2.weight(.medium))
                .textCase(.uppercase)
                .kerning(0.5)
                .foregroundStyle(ink.secondary)
            if items.isEmpty {
                Text("No data")
                    .font(.caption)
                    .foregroundStyle(ink.secondary)
            } else {
                ForEach(items.prefix(3)) { item in
                    WidgetBreakdownRow(item: item, models: models, locale: entry.locale)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Shared readings

    private func tokenValue(_ size: CGFloat) -> some View {
        Text(verbatim: tokensText)
            .font(.system(size: size, weight: .semibold))
            .monospacedDigit()
            .lineLimit(1)
            .minimumScaleFactor(0.65)
            .widgetAccentable()
            .accessibilityLabel("Tokens")
            .accessibilityValue(tokensText)
    }

    private var costValue: some View {
        Text(verbatim: costText)
            .font(.subheadline.weight(.medium))
            .monospacedDigit()
            .foregroundStyle(ink.secondary)
            .lineLimit(1)
            .minimumScaleFactor(0.75)
            .accessibilityLabel("Cost")
            .accessibilityValue(costIsKnown ? costText : String(localized: "Unavailable"))
    }

    private func edgeLabel(_ date: Date?) -> String {
        guard let date else { return "" }
        return date.formatted(
            .dateTime.month(.abbreviated).day().locale(entry.locale)
        )
    }

    private func lastLabel(for series: [WidgetActivityModel.Bar]) -> String {
        guard let date = series.last?.date else { return "" }
        if WidgetActivityModel.calendar.isDateInToday(date) {
            return String(localized: "Today", locale: entry.locale)
        }
        return edgeLabel(date)
    }

    static let overviewURL = URL(string: "tokenmonitor://overview")!
}
