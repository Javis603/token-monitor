import SwiftUI

struct CompactLimitProviderCard: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale

    let provider: LimitProvider

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 10) {
                ProviderMark(provider: provider.provider)

                VStack(alignment: .leading, spacing: 2) {
                    Text(ProviderPresentation.displayName(for: provider.provider))
                        .font(.subheadline)
                        .bold()
                    Text(provider.accountTitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .privacySensitive()
                }

                Spacer()

                if let updatedDate = Date.hubTimestamp(from: provider.updatedAt) {
                    Text(updatedDate.updateDescription(locale: locale))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(Array(provider.displayWindows.prefix(2))) { window in
                LimitWindowRow(provider: provider, window: window)
                    .padding(.top, 6)
            }
            if provider.displayWindows.isEmpty {
                Text("No quota windows available")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if provider.stale == true || (provider.status != nil && provider.status != "ok") {
                Label(provider.stale == true ? "Stale" : "Unavailable",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

}
