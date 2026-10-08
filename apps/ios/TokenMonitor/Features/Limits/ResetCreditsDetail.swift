import SwiftUI

/// A compact explanation attached to the reset indicator, rather than a settings page.
struct ResetCreditsDetail: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let credits: ProviderResetCredits

    var body: some View {
        ViewThatFits(in: .vertical) {
            content.fixedSize(horizontal: false, vertical: true)
            ScrollView { content }
                .scrollBounceBehavior(.basedOnSize)
        }
        .frame(idealWidth: 320, maxWidth: 320)
        .foregroundStyle(.primary)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Reset details")
                        .font(.subheadline.weight(.semibold))
                    if let count = credits.visibleCount {
                        Text(verbatim: MetricFormatter.resetCount(count, locale: Locale(identifier: "en")))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                Button("Done", systemImage: "xmark") { dismiss() }
                    .labelStyle(.iconOnly)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }

            Divider()
            if let grants = credits.grants, !grants.isEmpty {
                ForEach(Array(grants.enumerated()), id: \.offset) { index, grant in
                    if index > 0 { Divider() }
                    grantDetails(grant, showsCount: grants.count > 1)
                }
            } else {
                ForEach(Array(credits.expirationDates.enumerated()), id: \.offset) { _, date in
                    detailRow("Expires") { dateValue(date) }
                }
            }
        }
        .padding(16)
    }

    private func grantDetails(_ grant: ProviderResetGrant, showsCount: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let label = grant.label, !label.isEmpty {
                Text(verbatim: label)
                    .font(.footnote.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if showsCount, let count = grant.resetsLeft {
                Text(verbatim: MetricFormatter.resetCount(count, locale: Locale(identifier: "en")))
                    .foregroundStyle(.secondary)
            }
            if let start = Date.hubTimestamp(from: grant.startsAt) {
                detailRow("Available from") { dateValue(start) }
            }
            if let end = Date.hubTimestamp(from: grant.endsAt) {
                detailRow("Expires") { dateValue(end) }
                if end <= .now { Text("Expired").foregroundStyle(.secondary) }
            } else {
                Text("No expiry").foregroundStyle(.secondary)
            }
            if !grant.clearedWindowLabels.isEmpty {
                detailRow("Clears") {
                    Text(verbatim: grant.clearedWindowLabels.joined(separator: " · "))
                }
            }
            if grant.paused == true { Text("Paused").foregroundStyle(.secondary) }
            if grant.useRequiresLimit == true {
                Text("Usable at a limit only").foregroundStyle(.secondary)
            } else if grant.usableNow == false {
                Text("Not usable right now").foregroundStyle(.secondary)
            }
        }
        .font(.caption)
    }

    private func dateValue(_ date: Date) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            Text(date, format: .dateTime.year().month(.abbreviated).day())
            Text(date, format: .dateTime.hour().minute())
                .foregroundStyle(.secondary)
        }
        .monospacedDigit()
    }

    private func detailRow<Value: View>(
        _ title: LocalizedStringKey,
        @ViewBuilder value: () -> Value
    ) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        return layout {
            Text(title).foregroundStyle(.secondary)
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 8) }
            value()
                .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
        }
        .font(.caption)
        .accessibilityElement(children: .combine)
    }
}
