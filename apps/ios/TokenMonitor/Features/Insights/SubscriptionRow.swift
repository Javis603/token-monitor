import SwiftUI

struct SubscriptionRow: View {
    let record: SharedSubscription

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label {
                Text(ProviderPresentation.displayName(for: record.provider))
                    .font(.subheadline.weight(.semibold))
            } icon: {
                ProviderMark(provider: record.provider, size: 18)
            }
            if let plan = record.planName, !plan.isEmpty { Text(plan).font(.subheadline) }
            if record.isTopUp {
                Text(String(localized: "Top-ups", table: "AppAlignment")).font(.caption).foregroundStyle(.secondary)
            } else if let amount = record.amountMinor, amount.isFinite, amount >= 0 {
                Text(verbatim: MetricFormatter.currency(amount / 100, code: record.currency))
                    .monospacedDigit()
                Text(cadence).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var cadence: String {
        let count = min(24, max(1, record.intervalCount ?? 1))
        if count == 1 {
            return record.interval == "year" ? String(localized: "Billed yearly", table: "AppAlignment")
                : String(localized: "Billed monthly", table: "AppAlignment")
        }
        return record.interval == "year"
            ? String(localized: "Every \(count) years", table: "AppAlignment")
            : String(localized: "Every \(count) months", table: "AppAlignment")
    }
}
