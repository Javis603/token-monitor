import SwiftUI

/// Trend card: metric + range pickers, a big total/selection readout with the
/// range peak trailing, and the smooth area chart. `compact` (Overview) fixes
/// it to tokens over 30 days with no pickers.
struct InsightTrendCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var chartHeight = 170

    let history: UsageHistory
    var compact = false

    @State private var metric: TrendMetric = .tokens
    @State private var range: TrendRange = .days30
    @State private var selection: Date?

    enum TrendRange: String, CaseIterable, Identifiable {
        case days30
        case days90
        case year

        var id: Self { self }

        /// Days covered; the two long ranges chart weekly buckets.
        var dayCount: Int {
            switch self {
            case .days30: 30
            case .days90: 90
            case .year: 365
            }
        }

        var aggregatesWeekly: Bool { self != .days30 }

        var label: String {
            switch self {
            case .days30: "30 days"
            case .days90: "90 days"
            case .year: "1 year"
            }
        }

        var totalCaption: String {
            switch self {
            case .days30: "30-day total"
            case .days90: "90-day total"
            case .year: "1-year total"
            }
        }
    }

    private var activeMetric: TrendMetric { compact ? .tokens : metric }
    private var activeRange: TrendRange { compact ? .days30 : range }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !compact {
                controls
            }

            readout

            if buckets.isEmpty {
                Label("No Usage Yet", systemImage: "chart.xyaxis.line")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                UsageTrendChart(days: buckets, metric: activeMetric, selection: $selection)
                    .frame(height: compact ? chartHeight * 0.75 : chartHeight)
            }
        }
        .task {
            #if DEBUG
            guard ProcessInfo.processInfo.arguments.contains("--sample-trend-select") else { return }
            selection = buckets.dropFirst(buckets.count / 2).first?.dateValue
            #endif
        }
        .onChange(of: activeRange) { _, _ in selection = nil }
    }

    private var controls: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
        return layout {
            Picker("Metric", selection: $metric) {
                ForEach(TrendMetric.allCases) { metric in
                    Text(LocalizedStringKey(metric.label)).tag(metric)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : 160)

            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }

            Picker("Range", selection: $range) {
                ForEach(TrendRange.allCases) { range in
                    Text(LocalizedStringKey(range.label)).tag(range)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : 176)
        }
        .labelsHidden()
    }

    /// Big value: the selected bucket while scrubbing, else the range total.
    private var readout: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(headlineValue)
                    .font(.system(.title2, design: .rounded, weight: .semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text(LocalizedStringKey(headlineCaption))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text("Peak \(formatted(peakValue))")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
        }
    }

    private var headlineValue: String {
        if let day = selectedBucket {
            return formatted(activeMetric == .tokens ? day.tokens ?? 0 : day.cost ?? 0)
        }
        return formatted(rangeTotal)
    }

    private var headlineCaption: String {
        if let day = selectedBucket, let date = day.dateValue {
            return date.formatted(
                .dateTime.weekday(.abbreviated).month(.abbreviated).day()
                    .locale(locale)
            )
        }
        return activeRange.totalCaption
    }

    private var selectedBucket: HistoryDay? {
        guard let selection else { return nil }
        return buckets.min {
            abs(($0.dateValue ?? .distantPast).timeIntervalSince(selection))
                < abs(($1.dateValue ?? .distantPast).timeIntervalSince(selection))
        }
    }

    /// Days in range with a finite, non-negative value for the metric —
    /// missing days are gaps, not zeros.
    private var validDays: [HistoryDay] {
        let calendar = Calendar.current
        guard let cutoff = calendar.date(
            byAdding: .day,
            value: -activeRange.dayCount,
            to: calendar.startOfDay(for: .now)
        ) else { return [] }
        return (history.daily ?? [])
            .filter { day in
                guard let date = day.dateValue, date >= cutoff else { return false }
                let value = activeMetric == .tokens ? day.tokens : day.cost
                return value.map { $0.isFinite && $0 >= 0 } ?? false
            }
            .sorted { ($0.dateValue ?? .distantPast) < ($1.dateValue ?? .distantPast) }
    }

    private var buckets: [HistoryDay] {
        if !activeRange.aggregatesWeekly {
            return validDays
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let dayFormatter = DateFormatter()
        dayFormatter.calendar = calendar
        dayFormatter.locale = Locale(identifier: "en_US_POSIX")
        dayFormatter.timeZone = calendar.timeZone
        dayFormatter.dateFormat = "yyyy-MM-dd"

        let grouped = Dictionary(grouping: validDays) { day in
            calendar.dateInterval(of: .weekOfYear, for: day.dateValue ?? .distantPast)?.start
                ?? .distantPast
        }
        return grouped.compactMap { start, days -> HistoryDay? in
            let tokens = days.compactMap(\.tokens).reduce(0, +)
            let cost = days.compactMap(\.cost).reduce(0, +)
            let value = activeMetric == .tokens ? tokens : cost
            guard value.isFinite else { return nil }
            return HistoryDay(
                date: dayFormatter.string(from: start),
                tokens: days.allSatisfy { $0.tokens == nil } ? nil : tokens,
                cost: days.allSatisfy { $0.cost == nil } ? nil : cost,
                messages: nil,
                activeTimeMs: nil
            )
        }
        .sorted { ($0.dateValue ?? .distantPast) < ($1.dateValue ?? .distantPast) }
    }

    private var rangeTotal: Double {
        validDays.reduce(0) {
            $0 + (activeMetric == .tokens ? $1.tokens ?? 0 : $1.cost ?? 0)
        }
    }

    private var peakValue: Double {
        buckets.map { activeMetric == .tokens ? $0.tokens ?? 0 : $0.cost ?? 0 }.max() ?? 0
    }

    private func formatted(_ value: Double) -> String {
        activeMetric == .tokens
            ? MetricFormatter.tokens(value)
            : MetricFormatter.currencyFromUSD(value, currency: preferences.currency)
    }
}
