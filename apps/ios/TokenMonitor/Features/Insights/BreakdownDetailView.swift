import SwiftUI

struct BreakdownDetailView: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store

    let kind: BreakdownKind

    var body: some View {
        @Bindable var store = store

        ZStack {
            AppBackground()

            ScrollView {
                LazyVStack(spacing: 0) {
                    PeriodPicker(selection: $store.selectedPeriod)
                        .padding(.bottom, 18)

                    if entries.isEmpty {
                        ContentUnavailableView(
                            "No breakdown available",
                            systemImage: "chart.bar.xaxis"
                        )
                        .padding(.vertical, 56)
                    } else {
                        ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
                            if index > 0 {
                                Divider()
                            }
                            detailRow(entry)
                        }
                    }
                }
                .padding(.horizontal, DesignTokens.screenPadding)
                .padding(.bottom, DesignTokens.sectionSpacing)
            }
        }
        .navigationTitle(Text(LocalizedStringKey(kind.title)))
    }

    private var entries: [BreakdownEntry] {
        switch kind {
        case .tool: store.currentPeriod.clientEntries
        case .model: store.currentPeriod.modelEntries
        }
    }

    private var total: Double {
        max(0, store.currentPeriod.totalTokens ?? 0)
    }

    private func detailRow(_ entry: BreakdownEntry) -> some View {
        HStack(spacing: 12) {
            Image(kind.assetName(for: entry.id))
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(kind.color(for: entry.id))
                .frame(width: 26, height: 26)

            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline) {
                    Text(kind.displayName(for: entry.id))
                        .font(.headline)
                        .lineLimit(1)
                    Spacer()
                    Text(MetricFormatter.tokens(entry.value))
                        .bold()
                        .monospacedDigit()
                }

                ProgressView(value: share(for: entry), total: 1)
                    .tint(kind.color(for: entry.id))

                HStack {
                    Text(MetricFormatter.percent(share(for: entry) * 100))
                    Spacer()
                    Text(
                        MetricFormatter.currencyFromUSD(
                            entry.cost,
                            currency: preferences.currency
                        )
                    )
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 14)
        .accessibilityElement(children: .combine)
    }

    private func share(for entry: BreakdownEntry) -> Double {
        guard total > 0 else { return 0 }
        return min(1, max(0, entry.value / total))
    }
}
