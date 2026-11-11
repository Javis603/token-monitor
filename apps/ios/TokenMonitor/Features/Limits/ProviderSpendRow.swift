import SwiftUI

struct ProviderSpendRow: View {
    let provider: LimitProvider
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showsDetails = false

    var body: some View {
        if !entries.isEmpty {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
            layout {
                Text(verbatim: "Spend").foregroundStyle(.secondary)
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                Text(verbatim: summary).monospacedDigit()
                if entries.count > summaryEntries.count {
                    Button { showsDetails = true } label: {
                        Image(systemName: "info.circle")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel(String(localized: "Spending details", table: "AppAlignment"))
                    .popover(isPresented: $showsDetails) {
                        VStack(alignment: .leading, spacing: 12) {
                            PopoverHeader(LocalizedStringKey(String(localized: "Spending details", table: "AppAlignment")))
                            ForEach(entries, id: \.label) { entry in
                                LabeledContent(entry.label) {
                                    Text(verbatim: money(entry.amount)).monospacedDigit()
                                }
                            }
                        }
                        .font(.footnote).padding(16)
                        .presentationCompactAdaptation(.popover)
                    }
                }
            }
            .font(.caption)
        }
    }

    private var entries: [ProviderBalance.Spend] { provider.balance?.spendEntries ?? [] }
    private var summaryEntries: [ProviderBalance.Spend] {
        let preferred = entries.filter { $0.label == "Today" || $0.label == "Month" }
        return preferred.isEmpty ? Array(entries.prefix(2)) : preferred
    }
    private var summary: String {
        summaryEntries.map { "\($0.label) \(money($0.amount))" }.joined(separator: " · ")
    }
    private func money(_ amount: Double) -> String {
        MetricFormatter.currency(amount, code: provider.balance?.currency ?? "USD")
    }
}
