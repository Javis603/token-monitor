import SwiftUI

struct BackgroundReviewGroupRow: View {
    let entry: SessionListEntry
    let maximum: Double
    let now: Date
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var expanded = false
    @State private var visibleCount = 100
    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.rowBarSpacing) {
            Button { expanded.toggle() } label: {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: 12))
                layout {
                    HStack(alignment: .top, spacing: 8) {
                        ProviderMark(provider: "codex", size: markSize)
                        VStack(alignment: .leading, spacing: DesignTokens.rowLineSpacing) {
                            Text("Codex Auto Review").font(DesignTokens.rowTitle).lineLimit(1)
                            if let latest = entry.reviews.first {
                                let time = latest.value.lastActivity.map {
                                    $0.formatted(.dateTime.hour(.twoDigits(amPM: .omitted)).minute(.twoDigits))
                                } ?? "—"
                                Text("Recent \(time) · \(MetricFormatter.tokens(latest.value.measuredTokens ?? 0))")
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                            Text("\(entry.reviews.count) background runs").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
                    VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: DesignTokens.rowLineSpacing) {
                        Text(MetricFormatter.exactTokens(entry.tokens ?? 0)).font(DesignTokens.rowValue)
                        if let cost = entry.cost {
                            Text(MetricFormatter.usageCostFromUSD(cost, currency: preferences.currency))
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                        Image(systemName: expanded ? "chevron.up" : "chevron.down")
                            .font(.caption2).foregroundStyle(.secondary)
                    }.monospacedDigit().fixedSize(horizontal: true, vertical: false)
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect)
                .foregroundStyle(.primary)
            }
            .buttonStyle(.plain)
            UsageMeter(value: entry.tokens, maximum: maximum, color: ClientPresentation.color(for: "codex"))
            if expanded {
                LazyVStack(alignment: .leading, spacing: DesignTokens.rowDividerSpacing) {
                    ForEach(Array(entry.reviews.prefix(visibleCount)), id: \.key) { review in
                        Divider()
                        SessionRow(session: review.value, sessionKey: review.key,
                                   maximum: UsageRowPresentation.maximum(entry.reviews.map { $0.value.measuredTokens }), now: now)
                    }
                    if entry.reviews.count > visibleCount {
                        Button("Show more") { visibleCount += 100 }.frame(minHeight: DesignTokens.controlHeight)
                    }
                }
            }
        }
    }
}
