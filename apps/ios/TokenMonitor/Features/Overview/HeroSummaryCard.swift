import SwiftUI

struct HeroSummaryCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var headlineSize = 40

    let periodKey: UsagePeriodKey
    let period: UsagePeriod
    let updatedAt: String?

    var body: some View {
        SurfaceCard(glass: true) {
            VStack(alignment: .leading, spacing: 20) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline) {
                        periodTitle
                        Spacer(minLength: 8)
                        freshness
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        periodTitle
                        freshness
                    }
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text(period.totalTokens.map(MetricFormatter.tokens) ?? "—")
                        .font(.system(size: headlineSize, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .accessibilityLabel(period.totalTokens.map {
                            "\(MetricFormatter.exactTokens($0)) tokens"
                        } ?? String(localized: "No data"))
                    Text(period.costUsd.map {
                        MetricFormatter.currencyFromUSD($0, currency: preferences.currency)
                    } ?? "—")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                        .accessibilityLabel("Total cost")
                        .accessibilityValue(period.costUsd.map {
                            MetricFormatter.currencyFromUSD($0, currency: preferences.currency)
                        } ?? String(localized: "No data"))
                }
                Divider()
                let metricsLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
                metricsLayout {
                    metric("Cache read", value: period.cacheReadTokens)
                    metric("Cache write", value: period.cacheWriteTokens)
                    metric("Output", value: period.outputTokens)
                }
                NavigationLink {
                    SessionsView()
                } label: {
                    HStack(spacing: 8) {
                        Label("Sessions", systemImage: "bubble.left.and.bubble.right")
                            .font(.subheadline.weight(.medium))
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                    }
                    .foregroundStyle(.primary)
                    .frame(minHeight: DesignTokens.controlHeight)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .padding(.top, -8)
                .padding(.bottom, -10)
            }
        }
    }

    private var periodTitle: some View {
        Text(LocalizedStringKey(periodKey.title))
            .font(.subheadline.weight(.semibold))
    }

    @ViewBuilder
    private var freshness: some View {
        if let updatedDate = Date.hubTimestamp(from: updatedAt) {
            Text(updatedDate.updateDescription(locale: locale))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func metric(_ title: LocalizedStringKey, value: Double?) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value.map(MetricFormatter.tokens) ?? "—")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
