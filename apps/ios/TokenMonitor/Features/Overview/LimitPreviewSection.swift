import SwiftUI

/// Overview preview: the first `homeLimitCount` provider groups in the user's
/// limits order, compact (at most two windows per account).
struct LimitPreviewSection: View {
    let groups: [LimitProviderGroup]
    let showAll: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.headerToCardSpacing) {
            SectionHeader("AI Limits") {
                Button(action: showAll) {
                    Label("All", systemImage: "chevron.right")
                        .labelStyle(ReversedTitleIcon())
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .contentShape(.rect.inset(by: -10))
            }

            SurfaceCard {
                if groups.isEmpty {
                    Label("No limit data from this Hub", systemImage: "gauge.open.with.lines.needle.33percent")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 14) {
                        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
                            if index > 0 {
                                Divider()
                            }
                            ProviderLimitCard(providers: group.accounts, compact: true)
                        }
                    }
                }
            }
        }
    }
}

/// Trailing chevron after the title, for header accessories like "All ›".
struct ReversedTitleIcon: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.title
            configuration.icon
                .font(.caption.weight(.semibold))
        }
    }
}
