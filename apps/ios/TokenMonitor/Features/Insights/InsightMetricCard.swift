import SwiftUI

struct InsightMetricCard: View {
    @ScaledMetric(relativeTo: .subheadline) private var iconWidth = 18
    let title: String
    let value: String
    let systemImage: String
    let tint: Color
    var prominent = false

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Label {
                Text(LocalizedStringKey(title))
                    .foregroundStyle(.secondary)
            } icon: {
                Image(systemName: systemImage)
                    .foregroundStyle(tint)
                    .frame(width: iconWidth)
                    .accessibilityHidden(true)
            }
            .font(.subheadline)

            Text(value)
                .font(prominent ? .title3.weight(.semibold) : .headline)
                .monospacedDigit()
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 56, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }
}
