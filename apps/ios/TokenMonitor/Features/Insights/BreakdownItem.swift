import SwiftUI

struct BreakdownItem: View {
    let kind: BreakdownKind
    let entry: BreakdownEntry
    let total: Double

    var body: some View {
        HStack(spacing: 9) {
            Image(kind.assetName(for: entry.id))
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(kind.color(for: entry.id))
                .frame(width: 20, height: 20)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(kind.displayName(for: entry.id))
                    .font(.subheadline)
                    .lineLimit(1)

                HStack(spacing: 5) {
                    Text(MetricFormatter.tokens(entry.value))
                        .bold()
                        .monospacedDigit()

                    Text(MetricFormatter.percent(share * 100))
                        .foregroundStyle(.tertiary)
                }
                .font(.footnote)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var share: Double {
        guard total > 0 else {
            return 0
        }
        return min(1, max(0, entry.value / total))
    }
}
