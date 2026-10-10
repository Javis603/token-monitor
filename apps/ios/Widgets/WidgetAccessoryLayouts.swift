import SwiftUI
import WidgetKit

/// Lock Screen accessories — Solid only. Inline and circular keep their
/// compact readings; rectangular gets a provider's metered windows or the
/// period's usage.
struct WidgetAccessoryView: View {
    let entry: TokenMonitorWidgetEntry
    let family: WidgetFamily

    private var usage: TokenMonitorSharedPayload.Usage { entry.usage }
    private var tokensText: String {
        WidgetPresentation.tokens(usage.tokens, locale: entry.locale)
    }
    private var windows: [TokenMonitorSharedPayload.LimitWindow] {
        entry.visibleLimitWindows
    }

    /// The title's raw lookup key — the inline label renders it through
    /// `String(localized:)`, which takes a String, not a LocalizedStringKey.
    private var titleKey: String {
        switch entry.content {
        case "limits":
            return entry.preferredLimit
                .map { WidgetPresentation.displayName(for: $0.providerID) } ?? "AI Limits"
        case "activity": return "Activity"
        default:
            switch entry.period {
            case "month": return "This month"
            case "allTime": return "All time"
            default: return "Today"
            }
        }
    }

    private var title: LocalizedStringKey { LocalizedStringKey(titleKey) }

    private var symbol: String {
        switch entry.content {
        case "limits": "gauge.with.dots.needle.50percent"
        case "activity": "square.grid.3x3.fill"
        default: "number"
        }
    }

    private var headlineValue: String {
        guard entry.hasData else { return "—" }
        switch entry.content {
        case "limits":
            return windows.first.map {
                WidgetWindowColumn(window: $0, providerID: entry.preferredLimit?.providerID,
                                   now: entry.date, locale: entry.locale).shortValueText
            } ?? "—"
        case "activity":
            return WidgetActivityModel.today(entry.days, now: entry.date)
                .map { WidgetPresentation.tokens($0.tokens, locale: entry.locale) } ?? "—"
        default:
            return tokensText
        }
    }

    var body: some View {
        switch family {
        case .accessoryInline: inline
        case .accessoryCircular: circular
        default: rectangular
        }
    }

    // MARK: Inline

    private var inline: some View {
        ViewThatFits(in: .horizontal) {
            Label {
                Text("\(String(localized: String.LocalizationValue(titleKey), locale: entry.locale)): \(headlineValue)")
            } icon: {
                Image(systemName: entry.isStale ? "clock.badge.exclamationmark" : symbol)
            }
            Label(headlineValue, systemImage: entry.isStale ? "clock.badge.exclamationmark" : symbol)
        }
        .accessibilityLabel(title)
        .accessibilityValue(entry.isStale
            ? "\(headlineValue), \(String(localized: "Data may be out of date", locale: entry.locale))"
            : (entry.hasData ? headlineValue : String(localized: "No data", locale: entry.locale)))
    }

    // MARK: Circular

    private var circular: some View {
        ZStack {
            AccessoryWidgetBackground()
            if entry.hasData, entry.content == "limits",
               let fraction = WidgetPresentation.fraction(windows.first?.remainingPercent, total: 100) {
                Gauge(value: fraction) {
                    Image(systemName: entry.isStale ? "clock.badge.exclamationmark" : symbol)
                } currentValueLabel: {
                    Text(WidgetPresentation.percent(fraction * 100, locale: entry.locale))
                        .font(.caption.weight(.semibold))
                }
                .gaugeStyle(.accessoryCircular)
                .accessibilityLabel("Remaining")
            } else {
                VStack(spacing: 1) {
                    Image(systemName: entry.isStale ? "clock.badge.exclamationmark" : symbol)
                    Text(headlineValue)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .padding(4)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title)
        .accessibilityValue(entry.isStale
            ? String(localized: "Data may be out of date", locale: entry.locale)
            : headlineValue)
    }

    // MARK: Rectangular

    private var rectangular: some View {
        Group {
            switch entry.content {
            case "limits": limitsRectangular
            case "activity": activityRectangular
            default: usageRectangular
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    /// Provider name, then up to two `Session … 82%` rows with 3pt meters.
    private var limitsRectangular: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 4) {
                ActivityMark(providerID: entry.preferredLimit?.providerID, size: 12)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .widgetAccentable()
            if !entry.hasData {
                Text("No data")
                    .font(.caption)
            } else {
                ForEach(windows.prefix(2)) { window in
                    let column = WidgetWindowColumn(
                        window: window, providerID: entry.preferredLimit?.providerID,
                        now: entry.date, locale: entry.locale
                    )
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        Text(LocalizedStringKey(window.label))
                        Spacer(minLength: 4)
                        Text(verbatim: column.shortValueText)
                    }
                    .font(.caption2.monospacedDigit())
                    .lineLimit(1)
                    if let fraction = column.fraction {
                        ActivityMeter(
                            fraction: fraction,
                            tint: ActivityPalette.quotaTint(entry.preferredLimit?.providerID),
                            height: 3
                        )
                    }
                }
                if entry.isStale {
                    Text("Data may be out of date")
                        .font(.caption2)
                        .lineLimit(1)
                }
            }
        }
    }

    /// Σ + period title, the token headline, cost when shown.
    private var usageRectangular: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                ActivityMark(providerID: nil, size: 12)
                Text(entry.periodTitle)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
            }
            .widgetAccentable()
            Text(verbatim: headlineValue)
                .font(.headline)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if !entry.hasData {
                Text("No data")
                    .font(.caption)
            } else if entry.isStale {
                Text("Data may be out of date")
                    .font(.caption2)
                    .lineLimit(1)
            } else if entry.showsCost {
                Text(verbatim: costText)
                    .font(.caption)
                    .lineLimit(1)
            } else {
                Text("Tokens")
                    .font(.caption)
            }
        }
    }

    private var activityRectangular: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label(title, systemImage: symbol)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .widgetAccentable()
            Text(verbatim: headlineValue)
                .font(.headline)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if !entry.hasData {
                Text("No data")
                    .font(.caption)
            } else if entry.isStale {
                Text("Data may be out of date")
                    .font(.caption2)
                    .lineLimit(1)
            } else {
                Text("Today")
                    .font(.caption)
            }
        }
    }

    private var costText: String {
        guard usage.costKnown != false, usage.cost.isFinite else { return "—" }
        return WidgetPresentation.currencyFromUSD(
            usage.cost, displayCode: entry.currencyCode, locale: entry.locale
        )
    }
}
