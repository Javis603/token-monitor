import SwiftUI

/// Lifetime card: total tokens + cost up top, a tight 3×2 stat grid, then the
/// favourite model when the Hub reports one.
struct LifetimeCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0

    let summary: HistorySummary?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            let topLayout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 16))
            topLayout {
                headlineStat(
                    "Total tokens",
                    value: summary?.totalTokens.map(MetricFormatter.tokens) ?? "—"
                )
                headlineStat(
                    "Total cost",
                    value: summary?.totalCost.map {
                        MetricFormatter.currencyFromUSD($0, currency: preferences.currency)
                    } ?? "—"
                )
            }
            .accessibilityElement(children: .combine)

            Divider()

            LazyVGrid(
                columns: Array(
                    repeating: GridItem(.flexible(), spacing: 12),
                    count: dynamicTypeSize.isAccessibilitySize ? 1 : 3
                ),
                alignment: .leading,
                spacing: 14
            ) {
                InsightMetricCard(
                    title: "Active days",
                    value: summary?.activeDays.map(MetricFormatter.exactTokens) ?? "—",
                    systemImage: "calendar.badge.checkmark",
                    tint: DesignTokens.accent
                )
                InsightMetricCard(
                    title: "Current streak",
                    value: summary?.currentStreak.map {
                        MetricFormatter.days($0, locale: locale)
                    } ?? "—",
                    systemImage: "flame.fill",
                    tint: DesignTokens.warning
                )
                InsightMetricCard(
                    title: "Longest streak",
                    value: summary?.longestStreak.map {
                        MetricFormatter.days($0, locale: locale)
                    } ?? "—",
                    systemImage: "trophy.fill",
                    tint: .yellow
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
                    title: "Peak day",
                    value: summary?.peakDayTokens.map(MetricFormatter.tokens) ?? "—",
                    systemImage: "chart.line.uptrend.xyaxis",
                    tint: .orange
                )
            }

            if let model = summary?.favoriteModel, !model.isEmpty {
                Divider()
                HStack(spacing: 10) {
                    Image(systemName: "heart.fill")
                        .font(.caption)
                        .foregroundStyle(.pink)
                        .frame(width: 18)
                        .accessibilityHidden(true)
                    Text("Favorite model")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    ProviderMark(provider: ProviderPresentation.modelVendor(for: model), size: markSize)
                    Text(model)
                        .font(DesignTokens.rowTitle)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    private func headlineStat(_ title: LocalizedStringKey, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(.title, design: .rounded, weight: .semibold))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
