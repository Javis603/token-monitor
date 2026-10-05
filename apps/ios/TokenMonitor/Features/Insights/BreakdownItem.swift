import SwiftUI

struct BreakdownItem: View {
    let kind: BreakdownKind
    let entry: BreakdownEntry
    let total: Double

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
            layout {
                Text(kind.displayName(for: entry.id))
                    .font(.subheadline.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 30)
                    .overlay(alignment: .leading) {
                        Image(kind.assetName(for: entry.id))
                            .renderingMode(.template)
                            .resizable()
                            .scaledToFit()
                            .foregroundStyle(.primary)
                            .frame(width: 20, height: 20)
                            .accessibilityHidden(true)
                    }
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                Text(MetricFormatter.tokens(entry.value))
                    .font(.subheadline.weight(.semibold))
                    .monospacedDigit()
                    .fixedSize(horizontal: true, vertical: false)
            }
            HStack(spacing: 12) {
                ProgressView(value: share, total: 1)
                    .tint(kind.color(for: entry.id))
                    .accessibilityHidden(true)
                Text(MetricFormatter.percent(share * 100))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .frame(width: 42, alignment: .trailing)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private var share: Double {
        guard total > 0 else {
            return 0
        }
        return min(1, max(0, entry.value / total))
    }
}
