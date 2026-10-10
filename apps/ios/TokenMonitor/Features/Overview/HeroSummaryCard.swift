import SwiftUI

struct HeroSummaryCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var headlineSize = 40

    @State private var showsCacheDetails = false

    let period: UsagePeriod

    var body: some View {
        SurfaceCard {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    totalTitle
                    Text(period.totalTokens.map(MetricFormatter.exactTokens) ?? "—")
                        .font(.system(size: headlineSize, weight: .semibold))
                        .monospacedDigit()
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                        .contentTransition(reduceMotion ? .identity : .numericText(value: period.totalTokens ?? 0))
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: period.totalTokens)
                        .accessibilityLabel(period.totalTokens.map {
                            "\(MetricFormatter.exactTokens($0)) tokens"
                        } ?? String(localized: "No data"))
                    costReading
                    if store.stats?.allSourcesStale == true {
                        Label("Usage data is stale", systemImage: "clock.badge.exclamationmark")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Divider()
                let metricsLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 14))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
                metricsLayout {
                    cacheHitMetric
                    let messages = store.currentHistory.messageCount(for: store.selectedPeriod)
                    metric("Messages", value: messages.map(MetricFormatter.tokens),
                           accessibleValue: messages.map(MetricFormatter.exactTokens))
                    metric("Average speed", value: period.averageOutputTokensPerSecond.map {
                        $0.formatted(.number.precision(.fractionLength(0...1))) + " tok/s"
                    })
                    .accessibilityHint("Average output speed for requests with reported timing in the selected period.")
                }
            }
        }
        .onChange(of: store.selectedPeriod) {
            showsCacheDetails = false
        }
    }

    @ViewBuilder
    private var cacheHitMetric: some View {
        let value = period.cacheHitPercent.map(MetricFormatter.percent)
        if period.cacheHitUsesPartialData {
            Button {
                showsCacheDetails = true
            } label: {
                metric("Cache hit rate", value: value, showsInfo: true)
            }
            .buttonStyle(.plain)
            .contentShape(.rect.inset(by: -4))
            .accessibilityLabel("Cache hit rate")
            .accessibilityValue(value ?? String(localized: "No data"))
            .accessibilityHint("Cache hit rate uses classified data only.")
            .popover(isPresented: $showsCacheDetails) {
                Text("Cache hit rate uses classified data only.")
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(16)
                    .frame(idealWidth: 260, maxWidth: 280, alignment: .leading)
                    .presentationCompactAdaptation(.popover)
            }
        } else {
            metric("Cache hit rate", value: value)
        }
    }

    private var costReading: some View {
        Text(period.costUsd.map {
            MetricFormatter.currencyFromUSD($0, currency: preferences.currency)
        } ?? "—")
            .font(.title3)
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

    private func metric(_ title: LocalizedStringKey, value: String?, accessibleValue: String? = nil, showsInfo: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 4) {
                Text(title)
                    .lineLimit(1)
                if showsInfo {
                    Image(systemName: "info.circle")
                        .font(.caption2)
                        .accessibilityHidden(true)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Text(value ?? "—")
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(title))
        .accessibilityValue(accessibleValue ?? value ?? String(localized: "No data"))
    }
}
