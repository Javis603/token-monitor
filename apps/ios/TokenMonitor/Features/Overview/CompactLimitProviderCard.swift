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
                        .lineLimit(1)
                        .privacySensitive()
                }

                Spacer()

                if let updatedDate = Date.hubTimestamp(from: provider.updatedAt) {
                    Text(updatedDate.updateDescription(locale: locale))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }

            HStack(alignment: .top, spacing: 18) {
                ForEach(
                    Array(provider.displayWindows.prefix(2).enumerated()),
                    id: \.element.id
                ) { _, window in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(LocalizedStringKey(windowTitle(for: window)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .layoutPriority(1)

                            Spacer(minLength: 4)

                        Text(headline(for: window))
                            .font(.subheadline)
                            .bold()
                            .monospacedDigit()
                            .foregroundStyle(color(for: window))
                            .lineLimit(1)
                        }

                        if window.showMeter != false,
                           let remaining = provider.remainingPercent(for: window) {
                            ProgressView(value: remaining, total: 100)
                                .tint(color(for: window))
                        }

                        if let reset = resetText(for: window) {
                            Text(reset)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                                .lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func headline(for window: LimitWindow) -> String {
        if window.isCredits {
            if let amount = window.remaining ?? provider.balance?.amount {
                return MetricFormatter.currency(
                    amount,
                    sourceCode: window.currency ?? provider.balance?.currency ?? "USD",
                    displayCurrency: preferences.currency
                )
            }
            return "—"
        }
        guard let remaining = provider.remainingPercent(for: window) else {
            return "—"
        }
        return MetricFormatter.remaining(remaining, locale: locale)
    }

    private func windowTitle(for window: LimitWindow) -> String {
        let label = window.label?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let label, !label.isEmpty {
            return label
        }
        let kind = window.kind?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let kind, !kind.isEmpty {
            return kind.capitalized
        }
        return "Quota"
    }

    private func color(for window: LimitWindow) -> Color {
        guard let remaining = provider.remainingPercent(for: window) else {
            return .primary
        }
        if remaining <= 15 {
            return DesignTokens.critical
        }
        if remaining <= 35 {
            return DesignTokens.warning
        }
        return .primary
    }

    private func resetText(for window: LimitWindow) -> String? {
        if let description = window.resetDescription?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !description.isEmpty {
            return description
        }
        guard let resetDate = Date.hubTimestamp(from: window.resetsAt) else {
            return nil
        }
        return resetDate.formatted(
            .dateTime
                .weekday(.abbreviated)
                .hour()
                .minute()
        )
    }
}
