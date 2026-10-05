import SwiftUI

struct InsightMetricCard: View {
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
            }
            .font(.footnote)
            .lineLimit(1)
            .minimumScaleFactor(0.85)

            Text(value)
                .font(.headline)
                .bold()
                .monospacedDigit()
                .contentTransition(.numericText())
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
