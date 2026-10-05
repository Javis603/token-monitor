import SwiftUI

struct InsightTrendCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .body) private var chartHeight = 160

    let history: UsageHistory
    @State private var metric: TrendMetric = .tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Yearly activity")
                    .font(.headline)
                    .accessibilityAddTraits(.isHeader)
                ActivityHeatmap(model: yearHeatmap, metric: .tokens, currency: preferences.currency)
            }

            Divider()

            VStack(alignment: .leading, spacing: 12) {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
                layout {
                    Label("Daily activity", systemImage: "chart.line.uptrend.xyaxis")
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    Picker("Metric", selection: $metric) {
                        ForEach(TrendMetric.allCases) { metric in
                            Text(LocalizedStringKey(metric.label)).tag(metric)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : 176)
                }
                if validDays.isEmpty {
                    ContentUnavailableView("No Usage Yet", systemImage: "chart.xyaxis.line")
                } else {
                    UsageTrendChart(days: days, metric: metric)
                        .frame(height: chartHeight)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline) {
                            Text("Last 45 days")
                            Spacer(minLength: 8)
                            peak
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Last 45 days")
                            peak
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                if let model = history.summary?.favoriteModel, !model.isEmpty {
                    Text("Most used \(model)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var days: [HistoryDay] {
        Array((history.daily ?? []).sorted {
            ($0.dateValue ?? .distantPast) < ($1.dateValue ?? .distantPast)
        }.suffix(45))
    }

    private var validDays: [HistoryDay] {
        days.filter { day in
            let value = metric == .tokens ? day.tokens : day.cost
            return day.dateValue != nil && (value.map { $0.isFinite && $0 >= 0 } ?? false)
        }
    }

    private var peak: some View {
        let value = validDays.map { metric == .tokens ? $0.tokens ?? 0 : $0.cost ?? 0 }.max()
        return Text("Peak \(value.map(formatted) ?? "—")")
    }

    private var yearHeatmap: HeatmapModel {
        HeatmapModel.make(days: history.daily ?? [], metric: .tokens)
    }

    private func formatted(_ value: Double) -> String {
        metric == .tokens ? MetricFormatter.tokens(value)
            : MetricFormatter.currencyFromUSD(value, currency: preferences.currency)
    }
}
