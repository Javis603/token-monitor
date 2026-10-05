import SwiftUI

struct InsightTrendCard: View {
    @Environment(AppPreferences.self) private var preferences

    let history: UsageHistory

    @State private var metric: TrendMetric = .tokens

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Year in activity")
                .font(.headline)

            ActivityHeatmap(
                model: heatmap,
                metric: metric,
                currency: preferences.currency
            )

            HStack {
                Text("\(heatmap.activeDays) active days")

                Spacer()

                Text("Peak \(formattedPeak)")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            .contentTransition(.numericText())

            Divider()

            HStack {
                Label("Daily activity", systemImage: "chart.line.uptrend.xyaxis")
                    .font(.headline)

                Spacer()

                Picker("Metric", selection: $metric) {
                    ForEach(TrendMetric.allCases) { metric in
                        Text(metric.label).tag(metric)
                    }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 160)
            }

            UsageTrendChart(
                days: Array((history.daily ?? []).suffix(30)),
                metric: metric
            )
            .frame(height: 150)

            if let favoriteModel = history.summary?.favoriteModel,
               !favoriteModel.isEmpty {
                Label {
                    Text("Most used \(favoriteModel)")
                } icon: {
                    Image(
                        ProviderPresentation.assetName(
                            for: ProviderPresentation.modelVendor(for: favoriteModel)
                        )
                    )
                    .renderingMode(.template)
                }
                .font(.subheadline)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
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
