import SwiftUI

/// One cell in the lifetime stat grid: a small tinted symbol + caption label,
/// then the value.
struct InsightMetricCard: View {
    @ScaledMetric(relativeTo: .caption) private var iconWidth = 14
    let title: String
    let value: String
    let systemImage: String
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label {
                Text(LocalizedStringKey(title))
                    .foregroundStyle(.secondary)
            } icon: {
                Image(systemName: systemImage)
                    .foregroundStyle(tint)
                    .frame(width: iconWidth)
                    .accessibilityHidden(true)
            }
            .font(.caption)

            Text(value)
                .font(.headline)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}
