import Charts
import SwiftUI
import UIKit

/// Smooth desktop-style trend: accent area + line over date buckets (days or
/// weeks), three x-axis labels (start / middle / end), and a scrubbed rule +
/// point whose selection is snapped to the nearest bucket. `days` is expected
/// sorted and pre-filtered by the caller.
struct UsageTrendChart: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.locale) private var locale

    let days: [HistoryDay]
    let metric: TrendMetric
    @Binding var selection: Date?
    @State private var selectionFeedback = UISelectionFeedbackGenerator()

    var body: some View {
        Chart {
            ForEach(validDays) { day in
                AreaMark(
                    x: .value("Date", day.dateValue ?? .now),
                    y: .value(metric.label, value(for: day))
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [lineColor.opacity(0.28), lineColor.opacity(0)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .alignsMarkStylesWithPlotArea()
                .interpolationMethod(.monotone)

                LineMark(
                    x: .value("Date", day.dateValue ?? .now),
                    y: .value(metric.label, value(for: day))
                )
                .foregroundStyle(lineColor)
                .lineStyle(.init(lineWidth: 2, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.monotone)
            }

            if let day = selectedDay, let date = day.dateValue {
                RuleMark(x: .value("Date", date))
                    .foregroundStyle(.secondary.opacity(0.35))
                    .lineStyle(.init(lineWidth: 1, dash: [3, 3]))
                PointMark(x: .value("Date", date), y: .value(metric.label, value(for: day)))
                    .foregroundStyle(lineColor)
                    .symbolSize(40)
            }
        }
        .chartYAxis(.hidden)
        .chartXAxis {
            // Edge labels anchor inward so they render on the shared baseline
            // below the plot without clipping at the card edge.
            AxisMarks(values: axisDates) { value in
                let date = value.as(Date.self)
                let anchor: UnitPoint? =
                    date == axisDates.first ? .leading
                    : date == axisDates.last ? .trailing
                    : nil
                AxisValueLabel(
                    format: .dateTime.month(.abbreviated).day().locale(locale),
                    anchor: anchor
                )
            }
        }
        .chartXScale(domain: dateRange)
        .chartYScale(domain: 0...upperBound)
        .chartXSelection(value: snappedSelection)
        .accessibilityLabel("\(metric.label) trend for the last \(validDays.count) days")
    }

    private var lineColor: Color { DesignTokens.trendLine(for: colorScheme) }

    /// The raw chart x-selection snapped to the nearest bucket date.
    private var snappedSelection: Binding<Date?> {
        Binding(
            get: { selection },
            set: { newValue in
                let snapped = newValue.flatMap { date in
                    nearestDay(to: date)?.dateValue
                }
                guard snapped != selection else { return }
                selection = snapped
                if snapped != nil {
                    selectionFeedback.selectionChanged()
                    selectionFeedback.prepare()
                }
            }
        )
    }

    /// The selected bucket. `chartXSelection` reports nil again once the scrub
    /// ends, so the readout only tracks the finger while it is down.
    var selectedDay: HistoryDay? {
        guard let selection else { return nil }
        return nearestDay(to: selection)
    }

    private func nearestDay(to date: Date) -> HistoryDay? {
        validDays.min {
            abs(($0.dateValue ?? .distantPast).timeIntervalSince(date))
                < abs(($1.dateValue ?? .distantPast).timeIntervalSince(date))
        }
    }

    private var validDays: [HistoryDay] {
        days.filter { day in
            guard day.dateValue != nil else { return false }
            let amount = metric == .tokens ? day.tokens : day.cost
            return amount.map { $0.isFinite && $0 >= 0 } ?? false
        }.sorted { ($0.dateValue ?? .distantPast) < ($1.dateValue ?? .distantPast) }
    }

    private var upperBound: Double {
        max(1, (validDays.map(value(for:)).max() ?? 1) * 1.1)
    }

    /// Slightly padded so the edge x-axis labels render below the plot
    /// without clipping instead of overlapping the first/last points.
    private var dateRange: ClosedRange<Date> {
        let first = validDays.first?.dateValue ?? .now
        let last = validDays.last?.dateValue ?? first
        let span = max(86_400, last.timeIntervalSince(first))
        let pad = span * 0.04
        return first.addingTimeInterval(-pad)...last.addingTimeInterval(pad)
    }

    /// Exactly three x labels: first / middle / last bucket.
    private var axisDates: [Date] {
        guard let first = validDays.first?.dateValue,
              let last = validDays.last?.dateValue else {
            return []
        }
        let mid = Date(timeIntervalSince1970: (first.timeIntervalSince1970 + last.timeIntervalSince1970) / 2)
        return first == last ? [first] : [first, mid, last]
    }

    private func value(for day: HistoryDay) -> Double {
        switch metric {
        case .tokens: day.tokens ?? 0
        case .cost: day.cost ?? 0
        }
    }
}
