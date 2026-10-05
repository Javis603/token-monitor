import SwiftUI

struct LimitPreviewSection: View {
    let providers: [LimitProvider]
    let showAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    heading
                    Spacer()
                    allButton
                }
                VStack(alignment: .leading, spacing: 8) {
                    heading
                    allButton
                }
            }
            if providers.isEmpty {
                Label("No limit data from this Hub", systemImage: "gauge.open.with.lines.needle.33percent")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(LimitProviderGroup.grouped(providers).enumerated()), id: \.element.id) { index, group in
                    if index > 0 {
                        Divider().padding(.vertical, 4)
                    }
                    CompactLimitProviderCard(providers: group.accounts)
                }
            }
        }
    }

    private var heading: some View {
        Label("AI Limits", systemImage: "gauge")
            .font(.title3.weight(.semibold))
            .accessibilityAddTraits(.isHeader)
    }

    private var allButton: some View {
        Button("View all", systemImage: "arrow.right", action: showAll)
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: DesignTokens.controlHeight)
    }
}
