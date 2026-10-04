import Charts
import SwiftUI

struct UsageTrendChart: View {
    @Environment(AppPreferences.self) private var preferences
    let days: [HistoryDay]
    let metric: TrendMetric

    var body: some View {
        Chart(validDays) { day in
            AreaMark(
                x: .value("Date", day.dateValue ?? .now),
                y: .value(metric.label, value(for: day))
            )
            .foregroundStyle(
                LinearGradient(
                    colors: [
                        DesignTokens.accent.opacity(0.18),
                        DesignTokens.accent.opacity(0.02)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .interpolationMethod(.linear)

            LineMark(
                x: .value("Date", day.dateValue ?? .now),
                y: .value(metric.label, value(for: day))
            )
            .foregroundStyle(DesignTokens.accent)
            .lineStyle(.init(lineWidth: 2, lineCap: .round, lineJoin: .round))
            .interpolationMethod(.linear)
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { _ in
                AxisValueLabel(format: .dateTime.month(.abbreviated).day())
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { axis in
                AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5, dash: [3]))
                AxisValueLabel {
                    if let value = axis.as(Double.self) {
                        Text(metric == .tokens
                            ? MetricFormatter.tokens(value)
                            : MetricFormatter.currencyFromUSD(value, currency: preferences.currency))
                    }
                }
            }
        }
        .chartYScale(domain: 0...upperBound)
        .frame(minHeight: 150)
        .accessibilityLabel("\(metric.label) trend for the last \(validDays.count) days")
    }

    private var validDays: [HistoryDay] {
        days.filter { day in
            guard day.dateValue != nil else { return false }
            let amount = metric == .tokens ? day.tokens : day.cost
            return amount.map { $0.isFinite && $0 >= 0 } ?? false
        }
    }

    private var upperBound: Double {
        max(1, validDays.map(value(for:)).max() ?? 1)
    }

    private func value(for day: HistoryDay) -> Double {
        switch metric {
        case .tokens: day.tokens ?? 0
        case .cost: day.cost ?? 0
        }
    }
}
