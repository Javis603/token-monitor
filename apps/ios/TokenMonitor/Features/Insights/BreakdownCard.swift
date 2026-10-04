import SwiftUI

struct BreakdownCard: View {
    let title: String
    let imageName: String
    let kind: BreakdownKind
    let entries: [BreakdownEntry]
    let total: Double
    let limit: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            NavigationLink {
                BreakdownDetailView(kind: kind)
            } label: {
                HStack {
                    Text(LocalizedStringKey(title))
                        .font(.headline)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .frame(minHeight: DesignTokens.controlHeight, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if entries.isEmpty {
                Label("No breakdown available", systemImage: "chart.bar.xaxis")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                BreakdownList(kind: kind, entries: entries, total: total, limit: limit)
            }
        }
    }
}
