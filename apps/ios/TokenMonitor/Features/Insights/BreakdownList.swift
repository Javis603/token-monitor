import SwiftUI

struct BreakdownList: View {
    let kind: BreakdownKind
    let entries: [BreakdownEntry]
    let total: Double
    let limit: Int

    var body: some View {
        Grid(horizontalSpacing: 14, verticalSpacing: 0) {
            ForEach(rows.indices, id: \.self) { rowIndex in
                GridRow {
                    ForEach(rows[rowIndex]) { entry in
                        BreakdownItem(
                            kind: kind,
                            entry: entry,
                            total: total
                        )
                    }

                    if rows[rowIndex].count == 1 {
                        Color.clear
                    }
                }

                if rowIndex < rows.count - 1 {
                    Divider()
                        .gridCellColumns(2)
                }
            }
        }
    }

    private var visibleEntries: [BreakdownEntry] {
        Array(entries.prefix(max(0, limit)))
    }

    private var rows: [[BreakdownEntry]] {
        stride(from: 0, to: visibleEntries.count, by: 2).map { index in
            Array(visibleEntries[index..<min(index + 2, visibleEntries.count)])
        }
    }
}
