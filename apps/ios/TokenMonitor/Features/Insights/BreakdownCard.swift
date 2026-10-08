import SwiftUI

/// The section header owns navigation; the glass card contains only usage rows.
struct BreakdownCard: View {
    let kind: BreakdownKind
    let entries: [BreakdownEntry]
    let total: Double
    let limit: Int

    var body: some View {
        if entries.isEmpty {
            Label("No breakdown available", systemImage: "chart.bar.xaxis")
                .font(.subheadline).foregroundStyle(.secondary)
        } else {
            BreakdownList(kind: kind, entries: entries, total: total, limit: limit)
        }
    }
}
