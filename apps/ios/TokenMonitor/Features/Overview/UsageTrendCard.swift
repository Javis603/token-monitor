import SwiftUI

struct UsageTrendCard: View {
    let history: UsageHistory
    let metric: TrendMetric

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .firstTextBaseline) {
                Text("Daily activity")
                    .font(.headline)
                Spacer()
                Text("Last 14 days")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if days.isEmpty {
                Text("No Usage Yet")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                UsageTrendChart(days: days, metric: metric)
                    .frame(height: 120)
            }
        }
    }

    private var days: [HistoryDay] {
        Array((history.daily ?? []).sorted {
            ($0.dateValue ?? .distantPast) < ($1.dateValue ?? .distantPast)
        }.suffix(14))
    }
}
