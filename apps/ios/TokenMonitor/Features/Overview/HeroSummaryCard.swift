import SwiftUI

struct HeroSummaryCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var headlineSize = 40

    @Binding var selectedPeriod: UsagePeriodKey
    let period: UsagePeriod
    let updatedAt: String?

    var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 16) {
                summaryHeader

                VStack(alignment: .leading, spacing: 8) {
                    Text(period.totalTokens.map(MetricFormatter.exactTokens) ?? "—")
                        .font(.system(size: headlineSize, weight: .semibold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .accessibilityLabel(period.totalTokens.map {
                            "\(MetricFormatter.exactTokens($0)) tokens"
                        } ?? String(localized: "No data"))
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            costReading.fixedSize(horizontal: true, vertical: false)
                            Spacer(minLength: 0)
                            freshness.fixedSize(horizontal: true, vertical: false)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            costReading
                            freshness
                        }
                    }
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
                Divider()
                NavigationLink {
                    SessionsView()
                } label: {
                    HStack(spacing: 8) {
                        Label("Sessions", systemImage: "bubble.left.and.bubble.right")
                            .font(.subheadline.weight(.medium))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .foregroundStyle(.primary)
                    .frame(minHeight: DesignTokens.controlHeight)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var summaryHeader: some View {
        if dynamicTypeSize.isAccessibilitySize {
            expandedHeader
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    totalTitle.fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                    PeriodPicker(selection: $selectedPeriod, compact: true)
                        .fixedSize(horizontal: true, vertical: false)
                }
                expandedHeader
            }
        }
    }

    private var expandedHeader: some View {
        VStack(alignment: .leading, spacing: 8) {
            totalTitle
            PeriodPicker(selection: $selectedPeriod)
        }
    }

    private var costReading: some View {
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

    private var totalTitle: some View {
        Text("Total tokens")
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
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
                .lineLimit(1)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value.map(MetricFormatter.tokens) ?? "—")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityValue(value.map { MetricFormatter.exactTokens($0) + " tokens" } ?? String(localized: "No data"))
    }
}
