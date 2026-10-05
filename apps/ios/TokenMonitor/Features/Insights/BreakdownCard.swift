import SwiftUI

/// Top-N breakdown rows in a card, with a "Show all" row into the detail view.
/// The card title lives in the SectionHeader above it.
struct BreakdownCard: View {
    let kind: BreakdownKind
    let entries: [BreakdownEntry]
    let total: Double
    let limit: Int

    var body: some View {
        if entries.isEmpty {
            Label("No breakdown available", systemImage: "chart.bar.xaxis")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                BreakdownList(kind: kind, entries: entries, total: total, limit: limit)
                Divider()
                NavigationLink {
                    BreakdownDetailView(kind: kind)
                } label: {
                    HStack(alignment: .firstTextBaseline) {
                        Text("Show all")
                            .font(.subheadline.weight(.semibold))
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                    .foregroundStyle(.primary)
                    .frame(minHeight: DesignTokens.controlHeight, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }
}
