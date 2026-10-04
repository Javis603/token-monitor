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
                    .foregroundStyle(.secondary)
            }
            .font(.footnote)

            Text(value)
                .font(.title2.weight(.semibold))
                .bold()
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
