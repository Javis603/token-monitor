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
                SurfaceCard {
                    Label("No limit data from this Hub", systemImage: "gauge.open.with.lines.needle.33percent")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else {
                ForEach(providers) { provider in
                    SurfaceCard {
                        CompactLimitProviderCard(provider: provider)
                    }
                }
            }
        }
    }

    private var heading: some View {
        Text("AI Limits")
            .font(.title2.bold())
            .accessibilityAddTraits(.isHeader)
    }

    private var allButton: some View {
        Button("View all", systemImage: "arrow.right", action: showAll)
            .font(.subheadline.weight(.semibold))
            .frame(minHeight: DesignTokens.controlHeight)
    }
}
