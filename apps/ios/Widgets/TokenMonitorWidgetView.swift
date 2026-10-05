import SwiftUI
import WidgetKit

struct TokenMonitorWidgetView: View {
    @Environment(\.widgetFamily) private var family

    let entry: TokenMonitorWidgetEntry

    var body: some View {
        Group {
            if entry.snapshot == nil {
                emptyContent
            } else {
                switch entry.content {
                case "limits":
                    limitsContent
                case "activity":
                    activityContent
                default:
                    overviewContent
                }
            }
        }
        .padding(family == .accessoryRectangular ? 0 : 14)
        .containerBackground(.clear, for: .widget)
        .widgetURL(widgetDestinationURL)
        .environment(\.locale, entry.locale)
    }

    private var emptyContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            header(title: "Token Monitor", image: "TabOverview")
            Spacer(minLength: 0)
            Text("Open Token Monitor")
                .font(.headline)
            Text("Connect to your Hub to fill this widget.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    private var overviewContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            header(title: periodTitle, image: "TabOverview")

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(WidgetPresentation.tokens(entry.usage.tokens))
                    .font(.system(.title2, design: .rounded, weight: .bold))
                    .contentTransition(.numericText())
                    .minimumScaleFactor(0.7)
                Text("tokens")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }

            if family != .systemSmall, let tool = entry.usage.tools.first {
                breakdownRow(tool)
            }

            if family == .systemLarge {
                Divider()

                HStack(alignment: .top, spacing: 16) {
                    breakdownColumn(
                        title: "Tools",
                        items: Array(entry.usage.tools.prefix(3)),
                        models: false
                    )
                    breakdownColumn(
                        title: "Models",
                        items: Array(entry.usage.models.prefix(3)),
                        models: true
                    )
                }

                if entry.snapshot?.activity.isEmpty == false {
                    WidgetHeatmap(
                        days: entry.snapshot?.activity ?? [],
                        count: 182
                    )
                }
            }

            Spacer(minLength: 0)

            HStack {
                if entry.showsCost {
                    Label(
                        WidgetPresentation.currencyFromUSD(
                            entry.usage.cost,
                            displayCode: entry.currencyCode
                        ),
                        systemImage: "dollarsign.circle"
                    )
                }
                Spacer(minLength: 4)
                updateText
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    private var limitsContent: some View {
        VStack(alignment: .leading, spacing: 9) {
            if let limit = entry.preferredLimit {
                header(
                    title: WidgetPresentation.displayName(
                        for: limit.providerID
                    ),
                    image: WidgetPresentation.assetName(
                        for: limit.providerID
                    )
                )

                ForEach(limit.windows.prefix(maxLimitRows)) { window in
                    limitRow(window)
                }

                Spacer(minLength: 0)

                if entry.showsUpdateTime {
                    Text(updateLabel(for: limit.updatedAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            } else {
                header(title: "AI Limits", image: "TabLimits")
                Spacer(minLength: 0)
                Text("No limit data")
                    .font(.headline)
                Text("Refresh your reporting devices.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var activityContent: some View {
        VStack(alignment: .leading, spacing: 8) {
            header(title: "Activity", image: "TabInsights")

            WidgetHeatmap(
                days: entry.snapshot?.activity ?? [],
                count: heatmapDayCount
            )

            Spacer(minLength: 0)

            HStack {
                Text("Less")
                heatLegend
                Text("More")
                Spacer(minLength: 0)
                updateText
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
    }

    private func header(title: String, image: String) -> some View {
        HStack(spacing: 7) {
            Image(image)
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 18)
                .foregroundStyle(WidgetPresentation.accent)
            Text(title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Spacer(minLength: 0)
            Image(systemName: "circle.fill")
                .font(.system(size: 6))
                .foregroundStyle(WidgetPresentation.accent)
                .accessibilityLabel("Connected")
        }
    }

    private func breakdownRow(
        _ item: TokenMonitorSharedPayload.Breakdown
    ) -> some View {
        HStack(spacing: 7) {
            Image(WidgetPresentation.assetName(for: item.id))
                .resizable()
                .scaledToFit()
                .frame(width: 16, height: 16)
            Text(WidgetPresentation.displayName(for: item.id))
                .lineLimit(1)
            Spacer(minLength: 4)
            Text(WidgetPresentation.tokens(item.value))
                .monospacedDigit()
                .foregroundStyle(.secondary)
        }
        .font(.caption)
    }

    private func breakdownColumn(
        title: String,
        items: [TokenMonitorSharedPayload.Breakdown],
        models: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)

            ForEach(items) { item in
                HStack(spacing: 6) {
                    Image(
                        models
                            ? WidgetPresentation.modelAssetName(for: item.id)
                            : WidgetPresentation.assetName(for: item.id)
                    )
                    .resizable()
                    .scaledToFit()
                    .frame(width: 14, height: 14)

                    Text(
                        models
                            ? item.id
                            : WidgetPresentation.displayName(for: item.id)
                    )
                    .lineLimit(1)

                    Spacer(minLength: 2)
                }
                .font(.caption2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func limitRow(
        _ window: TokenMonitorSharedPayload.LimitWindow
    ) -> some View {
        VStack(spacing: 4) {
            HStack {
                Text(window.label)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let remaining = window.remainingPercent {
                    Text(WidgetPresentation.remaining(remaining, locale: entry.locale))
                        .monospacedDigit()
                        .foregroundStyle(
                            remaining <= 20 ? .red : .secondary
                        )
                } else if let amount = window.amount {
                    Text(
                        WidgetPresentation.currency(
                            amount,
                            sourceCode: window.currency ?? "USD",
                            displayCode: entry.currencyCode
                        )
                    )
                    .monospacedDigit()
                }
            }
            .font(.caption)

            if let remaining = window.remainingPercent {
                ProgressView(value: remaining, total: 100)
                    .tint(remaining <= 20 ? .red : WidgetPresentation.accent)
            }
        }
    }

    private var heatLegend: some View {
        HStack(spacing: 2) {
            ForEach(1...4, id: \.self) { level in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(WidgetPresentation.heatColor(level: level))
                    .frame(width: 7, height: 7)
            }
        }
    }

    @ViewBuilder
    private var updateText: some View {
        if entry.showsUpdateTime {
            Text(updateLabel(for: entry.snapshot?.updatedAt))
        }
    }

    private var periodTitle: String {
        switch entry.period {
        case "month": "This Month"
        case "allTime": "All Time"
        default: "Today"
        }
    }

    private var maxLimitRows: Int {
        switch family {
        case .systemLarge:
            4
        default:
            2
        }
    }

    private var heatmapDayCount: Int {
        switch family {
        case .systemSmall:
            84
        default:
            182
        }
    }

    private func updateLabel(for date: Date?) -> String {
        guard let date else {
            return "Not updated"
        }
        let seconds = max(0, Date.now.timeIntervalSince(date))
        if seconds < 60 {
            return "Just now"
        }
        if seconds < 3_600 {
            return "\(Int(seconds / 60))m ago"
        }
        if seconds < 86_400 {
            return "\(Int(seconds / 3_600))h ago"
        }
        return "\(Int(seconds / 86_400))d ago"
    }

    private var widgetDestinationURL: URL? {
        switch entry.content {
        case "limits":
            URL(string: "tokenmonitor://limits")
        case "activity":
            URL(string: "tokenmonitor://insights")
        default:
            URL(string: "tokenmonitor://overview")
        }
    }
}

private struct WidgetHeatmap: View {
    let days: [TokenMonitorSharedPayload.Day]
    let count: Int

    var body: some View {
        GeometryReader { proxy in
            let visibleDays = Array(days.suffix(count))
            let columns = max(1, Int(ceil(Double(visibleDays.count) / 7)))
            let cell = max(
                3,
                min(
                    11,
                    min(
                        (proxy.size.width - CGFloat(columns - 1) * 3)
                            / CGFloat(columns),
                        (proxy.size.height - 18) / 7
                    )
                )
            )

            HStack(spacing: 3) {
                ForEach(0..<columns, id: \.self) { column in
                    VStack(spacing: 3) {
                        ForEach(0..<7, id: \.self) { row in
                            let index = column * 7 + row
                            if index < visibleDays.count {
                                let day = visibleDays[index]
                                RoundedRectangle(
                                    cornerRadius: max(1.5, cell * 0.22),
                                    style: .continuous
                                )
                                .fill(
                                    WidgetPresentation.heatColor(
                                        level: intensity(
                                            value: day.tokens,
                                            days: visibleDays
                                        )
                                    )
                                )
                                .frame(width: cell, height: cell)
                                .accessibilityLabel(
                                    "\(day.date), \(WidgetPresentation.tokens(day.tokens)) tokens"
                                )
                            } else {
                                Color.clear
                                    .frame(width: cell, height: cell)
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .trailing)
        }
        .frame(height: 75)
    }

    private func intensity(
        value: Double,
        days: [TokenMonitorSharedPayload.Day]
    ) -> Int {
        guard value > 0, let maximum = days.map(\.tokens).max(), maximum > 0 else {
            return 0
        }
        let ratio = value / maximum
        if ratio >= 0.75 { return 4 }
        if ratio >= 0.5 { return 3 }
        if ratio >= 0.25 { return 2 }
        return 1
    }
}
