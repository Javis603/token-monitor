import Charts
import SwiftUI

struct UsageTrendChart: View {
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
                        DesignTokens.accent.opacity(0.35),
                        DesignTokens.accent.opacity(0.02)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
            )
            .interpolationMethod(.catmullRom)

            LineMark(
                x: .value("Date", day.dateValue ?? .now),
                y: .value(metric.label, value(for: day))
            )
            .foregroundStyle(DesignTokens.accent)
            .lineStyle(.init(lineWidth: 3, lineCap: .round, lineJoin: .round))
            .interpolationMethod(.catmullRom)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartYScale(domain: 0...upperBound)
        .frame(minHeight: 150)
        .accessibilityLabel("\(metric.label) trend for the last \(validDays.count) days")
    }

    private var validDays: [HistoryDay] {
        days.filter { $0.dateValue != nil }
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
