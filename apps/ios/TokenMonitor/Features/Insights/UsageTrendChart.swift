import Charts
import SwiftUI

struct UsageTrendChart: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    let days: [HistoryDay]
    let metric: TrendMetric
    @State private var selectedDate: Date?

    var body: some View {
        VStack(spacing: 10) {
            Chart {
                ForEach(validDays) { day in
                    AreaMark(
                        x: .value("Date", day.dateValue ?? .now),
                        y: .value(metric.label, value(for: day))
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [lineColor.opacity(0.13), lineColor.opacity(0)],
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
                    .lineStyle(.init(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                    .interpolationMethod(.monotone)
                }

                if let day = selectedDay, let date = day.dateValue {
                    RuleMark(x: .value("Date", date))
                        .foregroundStyle(.secondary.opacity(0.35))
                        .lineStyle(.init(lineWidth: 1, dash: [3, 3]))
                        .annotation(
                            position: .top, spacing: 4,
                            overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))
                        ) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(date.formatted(.dateTime.month(.abbreviated).day().locale(locale)))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Text(metric == .tokens
                                    ? MetricFormatter.tokens(value(for: day))
                                    : MetricFormatter.currencyFromUSD(value(for: day), currency: preferences.currency))
                                    .font(.subheadline.weight(.semibold).monospacedDigit())
                            }
                            .foregroundStyle(.primary)
                            .padding(10)
                            .background(
                                Color(uiColor: .secondarySystemGroupedBackground),
                                in: .rect(cornerRadius: 10)
                            )
                            .accessibilityElement(children: .combine)
                        }
                    PointMark(x: .value("Date", date), y: .value(metric.label, value(for: day)))
                        .foregroundStyle(lineColor)
                        .symbolSize(40)
                }
            }
            .chartXAxis(.hidden)
            .chartYAxis(.hidden)
            .chartXScale(domain: dateRange)
            .chartYScale(domain: 0...upperBound)
            .chartXSelection(value: $selectedDate)
            .chartGesture { proxy in
                SpatialTapGesture().onEnded { value in
                    proxy.selectXValue(at: value.location.x)
                }
            }
            .padding(.horizontal, 2)
            .accessibilityLabel("\(metric.label) trend for the last \(validDays.count) days")
            .accessibilityValue(selectedReading)

            if let first = validDays.first?.dateValue, let last = validDays.last?.dateValue {
                HStack(spacing: 4) {
                    Text(dateLabel(first))
                    Spacer(minLength: 0)
                    if first != last {
                        Text(dateLabel(first.addingTimeInterval(last.timeIntervalSince(first) / 2)))
                        Spacer(minLength: 0)
                        Text(dateLabel(last))
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 110)
    }

    private var lineColor: Color { DesignTokens.trendLine(for: colorScheme) }

    private var selectedDay: HistoryDay? {
        guard let selectedDate else { return nil }
        return validDays.min {
            abs(($0.dateValue ?? .distantPast).timeIntervalSince(selectedDate))
                < abs(($1.dateValue ?? .distantPast).timeIntervalSince(selectedDate))
        }
    }

    private var selectedReading: String {
        guard let day = selectedDay, let date = day.dateValue else { return "" }
        let amount = metric == .tokens
            ? MetricFormatter.exactTokens(value(for: day))
            : MetricFormatter.currencyFromUSD(value(for: day), currency: preferences.currency)
        return "\(date.formatted(.dateTime.month(.abbreviated).day().locale(locale))) \(amount)"
    }

    private var validDays: [HistoryDay] {
        days.filter { day in
            guard day.dateValue != nil else { return false }
            let amount = metric == .tokens ? day.tokens : day.cost
            return amount.map { $0.isFinite && $0 >= 0 } ?? false
        }.sorted { ($0.dateValue ?? .distantPast) < ($1.dateValue ?? .distantPast) }
    }

    private var upperBound: Double {
        max(1, (validDays.map(value(for:)).max() ?? 1) * 1.12)
    }

    private var dateRange: ClosedRange<Date> {
        let first = validDays.first?.dateValue ?? .now
        let last = validDays.last?.dateValue ?? first
        return first...(last > first ? last : first.addingTimeInterval(86_400))
    }

    private func dateLabel(_ date: Date) -> String {
        let calendar = Calendar(identifier: .gregorian)
        return "\(calendar.component(.month, from: date))/\(calendar.component(.day, from: date))"
    }

    private func value(for day: HistoryDay) -> Double {
        switch metric {
        case .tokens: day.tokens ?? 0
        case .cost: day.cost ?? 0
        }
    }
}
