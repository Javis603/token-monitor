import SwiftUI

struct ResetCreditsRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var showsDetails = false

    let credits: ProviderResetCredits

    var body: some View {
        if let count = credits.visibleCount {
            TimelineView(.periodic(from: .now, by: 60)) { context in
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                    : AnyLayout(HStackLayout(alignment: .center, spacing: 8))
                layout {
                    Text(verbatim: MetricFormatter.resetCount(count, locale: MetricFormatter.desktopQuotaLocale))
                        .fixedSize(horizontal: true, vertical: false)
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    if hasDetails {
                        expiryDetail(now: context.date)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.vertical, 2)
            }
        }
    }

    private var hasDetails: Bool {
        !credits.expirationDates.isEmpty || !(credits.grants ?? []).isEmpty
    }

    private func expiryDetail(now: Date) -> some View {
        HStack(spacing: 6) {
            if !credits.expirationDates.isEmpty {
                Text(verbatim: expirySummary(now: now))
                    .monospacedDigit()
                    .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Image(systemName: "info.circle")
                .font(.caption)
        }
        .accessibilityHidden(true)
        .overlay {
            Button {
                showsDetails = true
            } label: {
                Color.clear
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(minWidth: 44, minHeight: 44)
            .accessibilityLabel(Text("Reset details"))
            .accessibilityValue(Text(verbatim: expirySummary(now: now)))
            .popover(isPresented: $showsDetails) {
                ResetCreditsDetail(credits: credits)
                    .presentationCompactAdaptation(.popover)
            }
        }
    }

    private func expirySummary(now: Date) -> String {
        let dates = credits.expirationDates
        let displayedDates = dates.prefix(3)
        var parts = displayedDates.map {
            MetricFormatter.limitCountdown(to: $0, now: now, locale: MetricFormatter.desktopQuotaLocale)
        }
        if dates.count > 3 { parts.append("+\(dates.count - 3)") }
        return parts.joined(separator: " · ")
    }
}
