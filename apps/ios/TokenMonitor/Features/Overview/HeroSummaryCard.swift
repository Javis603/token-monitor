import SwiftUI

struct HeroSummaryCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var headlineSize = 56

    let periodKey: UsagePeriodKey
    let period: UsagePeriod
    let updatedAt: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 8) {
                Text(LocalizedStringKey(periodKey.title))
                    .font(.headline)
                    .foregroundStyle(.secondary)
                Text(period.totalTokens.map(MetricFormatter.tokens) ?? "—")
                    .font(.system(size: headlineSize, weight: .semibold))
                    .monospacedDigit()
                    .minimumScaleFactor(0.65)
                    .lineLimit(1)
                    .accessibilityLabel(
                        period.totalTokens.map { "\(MetricFormatter.exactTokens($0)) tokens" }
                            ?? String(localized: "No data")
                    )
                Text(period.costUsd.map {
                    MetricFormatter.currencyFromUSD($0, currency: preferences.currency)
                } ?? "—")
                .font(.title2.weight(.medium))
                .foregroundStyle(.secondary)
                .monospacedDigit()

                if let updatedDate = Date.hubTimestamp(from: updatedAt) {
                    Text(updatedDate.updateDescription(locale: locale))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 4)

            SurfaceCard {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 20))
                    : AnyLayout(HStackLayout(alignment: .top, spacing: 20))
                layout {
                    metric("Cache read", value: period.cacheReadTokens,
                           symbol: "bolt.horizontal.circle")
                    metric("Output", value: period.outputTokens,
                           symbol: "arrow.up.forward.circle")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func metric(_ title: LocalizedStringKey, value: Double?, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(value.map(MetricFormatter.tokens) ?? "—")
                .font(.title3.weight(.semibold))
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
