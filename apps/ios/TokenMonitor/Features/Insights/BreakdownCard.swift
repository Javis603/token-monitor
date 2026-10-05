import SwiftUI

struct BreakdownCard: View {
    let title: String
    let imageName: String
    let kind: BreakdownKind
    let entries: [BreakdownEntry]
    let total: Double
    let limit: Int

    var body: some View {
        NavigationLink {
            BreakdownDetailView(kind: kind)
        } label: {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Label {
                        Text(LocalizedStringKey(title))
                    } icon: {
                        Image(imageName)
                    }
                        .font(.headline)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }

                if entries.isEmpty {
                    Label("No breakdown available", systemImage: "chart.bar.xaxis")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 10)
                } else {
                    BreakdownList(
                        kind: kind,
                        entries: entries,
                        total: total,
                        limit: limit
                    )
                }
            }
        }
        .buttonStyle(.plain)
        .padding(.vertical, 4)
    }
}
