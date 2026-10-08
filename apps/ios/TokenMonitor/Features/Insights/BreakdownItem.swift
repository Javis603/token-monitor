import SwiftUI

struct BreakdownItem: View {
    let kind: BreakdownKind
    let entry: BreakdownEntry
    let total: Double
    var barMaximum: Double? = nil
    var showsCost = false

    @Environment(AppPreferences.self) private var preferences
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0
    @ScaledMetric(relativeTo: .subheadline) private var markInset = 26.0

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.rowBarSpacing) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
            layout {
                Text(kind.displayName(for: entry.id))
                    .font(DesignTokens.rowTitle)
                    .lineLimit(1).truncationMode(.tail)
                    .padding(.leading, markInset)
                    .overlay(alignment: .leading) {
                        Image(kind.assetName(for: entry.id))
                            .renderingMode(.template)
                            .resizable().scaledToFit()
                            .frame(width: markSize, height: markSize)
                            .accessibilityHidden(true)
                    }
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: 2) {
                    Text(showsCost ? MetricFormatter.exactTokens(entry.value) : MetricFormatter.tokens(entry.value))
                        .font(DesignTokens.rowValue)
                    if showsCost {
                        Text(MetricFormatter.usageCostFromUSD(entry.cost, currency: preferences.currency))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    } else {
                        Text(MetricFormatter.percent(UsageRowPresentation.share(entry.value, total: total) * 100))
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                .monospacedDigit()
                .fixedSize(horizontal: true, vertical: false)
            }
            UsageMeter(value: entry.value, maximum: barMaximum ?? total, color: kind.color(for: entry.id))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
