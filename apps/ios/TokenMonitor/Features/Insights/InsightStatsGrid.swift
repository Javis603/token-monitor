import SwiftUI

struct InsightStatsGrid: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let summary: HistorySummary?

    var body: some View {
        LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: 20),
                    count: dynamicTypeSize.isAccessibilitySize ? 1 : 2
                ),
                alignment: .leading,
                spacing: 24
            ) {
                InsightMetricCard(
                    title: "Total tokens",
                    value: summary?.totalTokens.map(MetricFormatter.tokens) ?? "—",
                    systemImage: "number",
                    tint: DesignTokens.accent,
                    prominent: true
                )

                InsightMetricCard(
                    title: "Total cost",
                    value: summary?.totalCost.map {
                        MetricFormatter.currencyFromUSD($0, currency: preferences.currency)
                    } ?? "—",
                    systemImage: "dollarsign.circle.fill",
                    tint: .green,
                    prominent: true
                )

                InsightMetricCard(
                    title: "Active days",
                    value: summary?.activeDays.map(MetricFormatter.exactTokens) ?? "—",
                    systemImage: "calendar.badge.checkmark",
                    tint: DesignTokens.accent
                )

                InsightMetricCard(
                    title: "Current streak",
                    value: summary?.currentStreak.map { MetricFormatter.days($0, locale: locale) } ?? "—",
                    systemImage: "flame.fill",
                    tint: DesignTokens.warning
                )

                InsightMetricCard(
                    title: "Active time",
                    value: summary?.activeTimeMs.map {
                        MetricFormatter.duration(milliseconds: $0, locale: locale)
                    } ?? "—",
                    systemImage: "clock.fill",
                    tint: .indigo
                )

                InsightMetricCard(
                    title: "Messages",
                    value: summary?.messages.map(MetricFormatter.tokens) ?? "—",
                    systemImage: "bubble.left.and.bubble.right.fill",
                    tint: .purple
                )

                InsightMetricCard(
                    title: "Longest streak",
                    value: summary?.longestStreak.map { MetricFormatter.days($0, locale: locale) } ?? "—",
                    systemImage: "trophy.fill",
                    tint: .yellow
                )

                InsightMetricCard(
                    title: "Peak day",
                    value: summary?.peakDayTokens.map(MetricFormatter.tokens) ?? "—",
                    systemImage: "chart.line.uptrend.xyaxis",
                    tint: .orange
                )
            }
        .padding(.vertical, 4)
    }
}
