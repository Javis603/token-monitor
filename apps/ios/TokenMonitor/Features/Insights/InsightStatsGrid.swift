import SwiftUI

struct InsightStatsGrid: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale

    let summary: HistorySummary?

    var body: some View {
        LazyVGrid(
                columns: [
                    GridItem(.flexible(), spacing: 18),
                    GridItem(.flexible(), spacing: 18)
                ],
                alignment: .leading,
                spacing: 14
            ) {
                InsightMetricCard(
                    title: "Total tokens",
                    value: MetricFormatter.tokens(summary?.totalTokens ?? 0),
                    systemImage: "number",
                    tint: DesignTokens.accent
                )

                InsightMetricCard(
                    title: "Total cost",
                    value: MetricFormatter.currencyFromUSD(
                        summary?.totalCost ?? 0,
                        currency: preferences.currency
                    ),
                    systemImage: "dollarsign.circle.fill",
                    tint: .green
                )

                InsightMetricCard(
                    title: "Active days",
                    value: MetricFormatter.exactTokens(summary?.activeDays ?? 0),
                    systemImage: "calendar.badge.checkmark",
                    tint: DesignTokens.accent
                )

                InsightMetricCard(
                    title: "Current streak",
                    value: MetricFormatter.days(
                        summary?.currentStreak ?? 0,
                        locale: locale
                    ),
                    systemImage: "flame.fill",
                    tint: DesignTokens.warning
                )

                InsightMetricCard(
                    title: "Active time",
                    value: MetricFormatter.duration(
                        milliseconds: summary?.activeTimeMs ?? 0,
                        locale: locale
                    ),
                    systemImage: "clock.fill",
                    tint: .indigo
                )

                InsightMetricCard(
                    title: "Messages",
                    value: MetricFormatter.tokens(summary?.messages ?? 0),
                    systemImage: "bubble.left.and.bubble.right.fill",
                    tint: .purple
                )

                InsightMetricCard(
                    title: "Longest streak",
                    value: MetricFormatter.days(
                        summary?.longestStreak ?? 0,
                        locale: locale
                    ),
                    systemImage: "trophy.fill",
                    tint: .yellow
                )

                InsightMetricCard(
                    title: "Peak day",
                    value: MetricFormatter.tokens(summary?.peakDayTokens ?? 0),
                    systemImage: "chart.line.uptrend.xyaxis",
                    tint: .orange
                )
            }
        .padding(.vertical, 4)
    }
}
