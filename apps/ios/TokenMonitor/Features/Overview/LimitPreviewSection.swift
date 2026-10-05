import SwiftUI

struct LimitPreviewSection: View {
    let providers: [LimitProvider]
    let showAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("AI Limits", systemImage: "gauge")
                    .font(.headline)

                Spacer()

                Button("View all", action: showAll)
                    .font(.subheadline)
            }

            if providers.isEmpty {
                Label("No limit data from this Hub", systemImage: "gauge.open.with.lines.needle.33percent")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 10)
            } else {
                ForEach(providers) { provider in
                    CompactLimitProviderCard(provider: provider)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if provider.id != providers.last?.id {
                        Divider()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
    }
}
