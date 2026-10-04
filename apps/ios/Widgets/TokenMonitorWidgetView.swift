import SwiftUI
import WidgetKit

struct TokenMonitorWidgetView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.dynamicTypeSize) private var typeSize
    let entry: TokenMonitorWidgetEntry

    var body: some View {
        Group {
            switch family {
            case .accessoryInline: inlineContent
            case .accessoryCircular: circularContent
            case .accessoryRectangular: rectangularContent
            default: homeContent
            }
        }
        // WidgetKit owns the removable background, margins, and Liquid Glass treatment.
        .containerBackground(.background, for: .widget)
        .widgetURL(destination)
        .environment(\.locale, entry.locale)
    }

    private var accent: Color { renderingMode == .fullColor ? WidgetPresentation.accent : .primary }
    private var isSmall: Bool { family == .systemSmall }
    private var isLarge: Bool { family == .systemLarge }
    private var days: [TokenMonitorSharedPayload.Day] {
        (entry.snapshot?.activity ?? []).sorted { $0.date < $1.date }
    }
    private var window: TokenMonitorSharedPayload.LimitWindow? { entry.preferredLimit?.windows.first }
    private var periodTitle: String {
        switch entry.period {
        case "month": "This Month"
        case "allTime": "All Time"
        default: "Today"
        }
    }
    private var title: String {
        switch entry.content {
        case "limits": entry.preferredLimit.map { WidgetPresentation.displayName(for: $0.providerID) } ?? "AI Limits"
        case "activity": "Activity"
        default: periodTitle
        }
    }
    private var symbol: String {
        switch entry.content {
        case "limits": "gauge.with.dots.needle.50percent"
        case "activity": "chart.bar.xaxis"
        default: "number"
        }
    }
    private var hasData: Bool {
        guard entry.snapshot != nil else { return false }
        switch entry.content {
        case "limits": return window != nil
        case "activity": return !days.isEmpty
        default: return true
        }
    }
    private var dataDate: Date? {
        entry.content == "limits" ? entry.preferredLimit?.updatedAt : entry.snapshot?.updatedAt
    }
    private var isStale: Bool { entry.isStale }
    private var headlineValue: String {
        guard hasData else { return "—" }
        switch entry.content {
        case "limits": return window.map(limitValue) ?? "—"
        case "activity": return days.last.map { tokens($0.tokens) } ?? "—"
        default: return tokens(entry.usage.tokens)
        }
    }
    private func tokens(_ value: Double) -> String { WidgetPresentation.tokens(value, locale: entry.locale) }

    private var homeContent: some View {
        VStack(alignment: .leading, spacing: isSmall ? 8 : 12) {
            header
            if !hasData {
                Spacer(minLength: 0)
                Text(entry.snapshot == nil ? "Open Token Monitor" : "No data")
                    .font(.headline)
                Text(entry.snapshot == nil ? "Connect to your Hub to fill this widget." : "Refresh your reporting devices.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                Spacer(minLength: 0)
            } else {
                switch entry.content {
                case "limits": limitsContent
                case "activity": activityContent
                default: overviewContent
                }
                Spacer(minLength: 0)
                freshness
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
                .foregroundStyle(accent)
                .widgetAccentable()
                .accessibilityHidden(true)
            Text(LocalizedStringKey(title))
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 0)
            if isStale {
                Image(systemName: "clock.badge.exclamationmark")
                    .accessibilityLabel("Data may be out of date")
            }
        }
    }

    private var overviewContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if isSmall {
                tokenMetric
                if entry.showsCost, !typeSize.isAccessibilitySize { costMetric }
            } else {
                HStack(alignment: .top, spacing: 20) {
                    tokenMetric.frame(maxWidth: .infinity, alignment: .leading)
                    if entry.showsCost { costMetric.frame(maxWidth: .infinity, alignment: .leading) }
                }
            }
            if isLarge {
                Divider()
                breakdown(title: "Tools", items: entry.usage.tools, models: false)
                if !typeSize.isAccessibilitySize {
                    Divider()
                    breakdown(title: "Models", items: entry.usage.models, models: true)
                }
            }
        }
    }

    private var tokenMetric: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(tokens(entry.usage.tokens))
                .font(.system(isSmall && !typeSize.isAccessibilitySize ? .largeTitle : .title, design: .rounded, weight: .bold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .widgetAccentable()
            Text("Tokens").font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private var costMetric: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(WidgetPresentation.currencyFromUSD(entry.usage.cost, displayCode: entry.currencyCode, locale: entry.locale))
                .font(isSmall ? .subheadline.weight(.semibold) : .title3.weight(.semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            Text("Cost").font(.caption).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func breakdown(title: LocalizedStringKey, items: [TokenMonitorSharedPayload.Breakdown], models: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if items.isEmpty {
                Text("No data").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(items.prefix(typeSize.isAccessibilitySize ? 1 : 2)) { item in
                breakdownRow(item, models: models)
            }
        }
    }

    private func breakdownRow(_ item: TokenMonitorSharedPayload.Breakdown, models: Bool) -> some View {
        HStack(spacing: 8) {
            Image(models ? WidgetPresentation.modelAssetName(for: item.id) : WidgetPresentation.assetName(for: item.id))
                .resizable()
                .widgetAccentedRenderingMode(.accentedDesaturated)
                .scaledToFit()
                .frame(width: 18, height: 18)
                .accessibilityHidden(true)
            Text(models ? item.id : WidgetPresentation.displayName(for: item.id)).lineLimit(1)
            Spacer(minLength: 4)
            Text(tokens(item.value)).monospacedDigit().foregroundStyle(.secondary)
        }
        .font(.caption)
        .accessibilityElement(children: .combine)
        .accessibilityValue("Tokens")
    }

    private var limitsContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let limit = entry.preferredLimit {
                ForEach(limit.windows.prefix(isLarge && !typeSize.isAccessibilitySize ? 4 : 1)) { item in
                    limitRow(item)
                }
            }
        }
    }

    private func limitRow(_ item: TokenMonitorSharedPayload.LimitWindow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(LocalizedStringKey(item.label)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            Text(limitValue(item))
                .font(isSmall ? .title2.bold() : .headline)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .widgetAccentable()
            if let fraction = WidgetPresentation.fraction(item.remainingPercent, total: 100) {
                ProgressView(value: fraction)
                    .tint(accent)
                    .widgetAccentable()
                    .accessibilityLabel("Remaining")
                    .accessibilityValue(WidgetPresentation.percent(fraction * 100, locale: entry.locale))
            }
            if isLarge, let reset = item.resetAt {
                HStack(spacing: 4) {
                    Text("Resets")
                    Text(reset, style: .relative)
                }
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func limitValue(_ item: TokenMonitorSharedPayload.LimitWindow) -> String {
        if let amount = item.amount, amount.isFinite {
            guard let currency = item.currency, !currency.isEmpty else {
                return amount.formatted(.number.precision(.fractionLength(0...2)).locale(entry.locale))
            }
            return WidgetPresentation.currency(amount, sourceCode: currency, displayCode: entry.currencyCode, locale: entry.locale)
        }
        if let fraction = WidgetPresentation.fraction(item.remainingPercent, total: 100) {
            return WidgetPresentation.remaining(fraction * 100, locale: entry.locale)
        }
        return "—"
    }

    private var activityContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let latest = days.last {
                HStack(alignment: .firstTextBaseline) {
                    Text(tokens(latest.tokens)).font(.title2.bold()).monospacedDigit().widgetAccentable()
                    Text("Tokens").font(.caption).foregroundStyle(.secondary)
                }
                Text(latest.date).font(.caption).foregroundStyle(.secondary)
            }
            if !typeSize.isAccessibilitySize {
                WidgetHeatmap(days: Array(days.suffix(isLarge ? 84 : 14)), locale: entry.locale)
                    .frame(maxHeight: .infinity)
            }
            if isLarge, entry.showsCost, let latest = days.last {
                LabeledContent("Cost", value: WidgetPresentation.currencyFromUSD(latest.cost, displayCode: entry.currencyCode, locale: entry.locale))
                    .font(.subheadline)
            }
        }
    }

    @ViewBuilder private var freshness: some View {
        if isStale {
            Label("Data may be out of date", systemImage: "clock.badge.exclamationmark")
                .font(.caption).foregroundStyle(.secondary).lineLimit(2)
        } else if entry.showsUpdateTime {
            if let dataDate {
                HStack(spacing: 4) {
                    Text("Updated")
                    Text(dataDate, style: .relative)
                }
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            } else {
                Text("Not updated").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var inlineContent: some View {
        ViewThatFits(in: .horizontal) {
            Label {
                Text("\(String(localized: String.LocalizationValue(title), locale: entry.locale)): \(headlineValue)")
            } icon: { Image(systemName: isStale ? "clock.badge.exclamationmark" : symbol) }
            Label(headlineValue, systemImage: isStale ? "clock.badge.exclamationmark" : symbol)
        }
        .accessibilityLabel(LocalizedStringKey(title))
        .accessibilityValue(isStale
            ? "\(headlineValue), \(String(localized: "Data may be out of date", locale: entry.locale))"
            : (hasData ? headlineValue : String(localized: "No data", locale: entry.locale)))
    }

    private var circularContent: some View {
        ZStack {
            AccessoryWidgetBackground()
            if hasData, entry.content == "limits", let fraction = WidgetPresentation.fraction(window?.remainingPercent, total: 100) {
                Gauge(value: fraction) {
                    Image(systemName: isStale ? "clock.badge.exclamationmark" : symbol)
                } currentValueLabel: {
                    Text(WidgetPresentation.percent(fraction * 100, locale: entry.locale)).font(.caption.weight(.semibold))
                }
                .gaugeStyle(.accessoryCircular)
                .accessibilityLabel("Remaining")
            } else {
                VStack(spacing: 1) {
                    Image(systemName: isStale ? "clock.badge.exclamationmark" : symbol)
                    Text(headlineValue).font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
                }
                .padding(4)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(LocalizedStringKey(title))
        .accessibilityValue(isStale ? String(localized: "Data may be out of date", locale: entry.locale) : headlineValue)
    }

    private var rectangularContent: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(LocalizedStringKey(title), systemImage: symbol).font(.caption.weight(.semibold)).lineLimit(1).widgetAccentable()
            Text(headlineValue).font(.headline).monospacedDigit().lineLimit(1).minimumScaleFactor(0.8)
            if !hasData {
                Text("No data").font(.caption)
            } else if isStale {
                Text("Data may be out of date").font(.caption).lineLimit(1)
            } else if entry.content == "limits", let window {
                Text(LocalizedStringKey(window.label)).font(.caption).lineLimit(1)
            } else if entry.content == "activity", let latest = days.last {
                Text(latest.date).font(.caption)
            } else {
                Text("Tokens").font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var destination: URL? {
        URL(string: "tokenmonitor://\(entry.content == "limits" ? "limits" : (entry.content == "activity" ? "insights" : "overview"))")
    }
}

private struct WidgetHeatmap: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let days: [TokenMonitorSharedPayload.Day]
    let locale: Locale

    var body: some View {
        // Each tile represents an actual reported day; absent days are never filled in.
        let maximum = days.map(\.tokens).filter { $0.isFinite }.max() ?? 0
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: 7), spacing: 4) {
            ForEach(Array(days.enumerated()), id: \.offset) { _, day in
                let fraction = WidgetPresentation.fraction(day.tokens, total: maximum) ?? 0
                RoundedRectangle(cornerRadius: 3)
                    .fill(renderingMode == .fullColor ? WidgetPresentation.accent : Color.primary)
                    .opacity(day.tokens > 0 ? 0.3 + fraction * 0.7 : 0.12)
                    .frame(maxHeight: .infinity)
                    .frame(minHeight: 6)
                    .widgetAccentable()
                    .accessibilityLabel("\(day.date), \(WidgetPresentation.tokens(day.tokens, locale: locale)) tokens")
            }
        }
    }
}
