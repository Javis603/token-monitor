import SwiftUI

struct BreakdownList: View {
    let kind: BreakdownKind
    let entries: [BreakdownEntry]
    let total: Double
    let limit: Int

    var body: some View {
        VStack(spacing: 18) {
            ForEach(Array(entries.prefix(max(0, limit)))) { entry in
                BreakdownItem(kind: kind, entry: entry, total: total)
            }
        }
    }
}
