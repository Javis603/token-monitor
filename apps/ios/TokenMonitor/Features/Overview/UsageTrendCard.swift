import SwiftUI

struct UsageTrendCard: View {
    @Environment(AppPreferences.self) private var preferences

    let history: UsageHistory
    let metric: TrendMetric

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label("Activity", systemImage: "chart.line.uptrend.xyaxis")
                    .font(.headline)

                Spacer()

                Text("\(heatmap.activeDays) active days")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            ActivityHeatmap(
                model: heatmap,
                metric: metric,
                currency: preferences.currency
            )
        }
        .padding(.vertical, 4)
    }

    private var heatmap: HeatmapModel {
        HeatmapModel.make(
            days: history.daily ?? [],
            metric: metric,
            weekCount: 26
        )
    }
}
