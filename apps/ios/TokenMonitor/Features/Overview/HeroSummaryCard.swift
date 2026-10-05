import SwiftUI

struct HeroSummaryCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale

    let periodKey: UsagePeriodKey
    let period: UsagePeriod
    let updatedAt: String?

    var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(LocalizedStringKey(periodKey.title))
                        .font(.subheadline)
                        .bold()
                        .foregroundStyle(.secondary)

                    Spacer()

                    if let updatedDate = Date.hubTimestamp(from: updatedAt) {
                        Text(updatedDate.updateDescription(locale: locale))
                            .font(.footnote)
                            .foregroundStyle(.tertiary)
                    }
                }

                VStack(alignment: .leading, spacing: 4) {
                    Text(MetricFormatter.tokens(period.totalTokens ?? 0))
                        .font(.largeTitle)
                        .bold()
                        .contentTransition(.numericText())
                        .accessibilityLabel(
                            "\(MetricFormatter.exactTokens(period.totalTokens ?? 0)) tokens"
                        )

                    Text(
                        MetricFormatter.currencyFromUSD(
                            period.costUsd ?? 0,
                            currency: preferences.currency
                        )
                    )
                        .font(.title3)
                        .foregroundStyle(.secondary)
                        .contentTransition(.numericText())
                }

                Divider()

                Grid(horizontalSpacing: 18) {
                    GridRow {
                        LabeledContent {
                            Text(MetricFormatter.tokens(period.cacheReadTokens ?? 0))
                                .bold()
                                .monospacedDigit()
                        } label: {
                            Label("Cache read", systemImage: "bolt.horizontal.circle.fill")
                                .foregroundStyle(.secondary)
                        }

                        LabeledContent {
                            Text(MetricFormatter.tokens(period.outputTokens ?? 0))
                                .bold()
                                .monospacedDigit()
                        } label: {
                            Label("Output", systemImage: "arrow.up.forward.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .font(.footnote)
            }
        }
    }
}
