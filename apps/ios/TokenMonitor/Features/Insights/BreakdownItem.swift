import SwiftUI

struct BreakdownItem: View {
    let kind: BreakdownKind
    let entry: BreakdownEntry
    let total: Double

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(kind.assetName(for: entry.id))
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(kind.color(for: entry.id))
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 8) {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
                layout {
                    Text(kind.displayName(for: entry.id))
                        .font(.subheadline.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    Text(MetricFormatter.tokens(entry.value))
                        .font(.subheadline.weight(.semibold))
                        .monospacedDigit()
                }
                ProgressView(value: share, total: 1)
                    .tint(DesignTokens.accent.opacity(0.8))
                    .accessibilityHidden(true)
                Text(MetricFormatter.percent(share * 100))
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
