import SwiftUI

struct InsightTrendCard: View {
    @Environment(AppPreferences.self) private var preferences
    @ScaledMetric(relativeTo: .body) private var chartHeight = 190

    let history: UsageHistory

    @State private var metric: TrendMetric = .tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Daily activity")
                    .font(.title2.bold())
                    .accessibilityAddTraits(.isHeader)
                Picker("Metric", selection: $metric) {
                    ForEach(TrendMetric.allCases) { metric in
                        Text(LocalizedStringKey(metric.label)).tag(metric)
                    }
                }
                .pickerStyle(.segmented)
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 16) {
                        if (history.daily ?? []).isEmpty {
                            ContentUnavailableView("No Usage Yet", systemImage: "chart.xyaxis.line")
                        } else {
                            UsageTrendChart(
                                days: Array((history.daily ?? []).suffix(30)), metric: metric
                            )
                            .frame(height: chartHeight)
                        }
                        if let favoriteModel = history.summary?.favoriteModel, !favoriteModel.isEmpty {
                            Text("Most used \(favoriteModel)")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            VStack(alignment: .leading, spacing: 16) {
                Text("Year in activity")
                    .font(.title2.bold())
                    .accessibilityAddTraits(.isHeader)
                SurfaceCard {
                    VStack(alignment: .leading, spacing: 16) {
                        ActivityHeatmap(model: heatmap, metric: metric, currency: preferences.currency)
                        ViewThatFits(in: .horizontal) {
                            HStack {
                                Text("\(heatmap.activeDays) active days")
                                Spacer()
                                Text("Peak \(formattedPeak)")
                            }
                            VStack(alignment: .leading, spacing: 6) {
                                Text("\(heatmap.activeDays) active days")
                                Text("Peak \(formattedPeak)")
                            }
                        }
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private var heatmap: HeatmapModel {
        HeatmapModel.make(
            days: history.daily ?? [],
            metric: metric
        )
    }

    private var formattedPeak: String {
        switch metric {
        case .tokens:
            MetricFormatter.tokens(heatmap.peakValue)
        case .cost:
            MetricFormatter.currencyFromUSD(
                heatmap.peakValue,
                currency: preferences.currency
            )
        }
    }
}
