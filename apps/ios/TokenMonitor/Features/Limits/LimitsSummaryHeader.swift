import SwiftUI

struct LimitsSummaryHeader: View {
    @Environment(\.locale) private var locale

    let providers: [LimitProvider]
    let updatedAt: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(MetricFormatter.accountCount(providers.count, locale: locale))
                    .font(.title2.bold())
                    .contentTransition(.numericText())

                if let updatedDate = Date.hubTimestamp(from: updatedAt) {
                    Text(updatedDate.updateDescription(locale: locale))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }


            if attentionCount > 0 {
                Label(
                    MetricFormatter.attentionCount(attentionCount, locale: locale),
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.footnote)
                .foregroundStyle(DesignTokens.warning)
            }
        }
        .padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }

    private var attentionCount: Int {
        providers.count { provider in
            provider.stale == true
                || (provider.status != nil && provider.status != "ok")
        }
    }
}
