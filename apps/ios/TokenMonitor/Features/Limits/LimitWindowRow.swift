import SwiftUI

struct LimitWindowRow: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale

    let provider: LimitProvider
    let window: LimitWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(LocalizedStringKey(windowTitle))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Spacer()

                if let headline {
                    Text(headline)
                        .bold()
                        .monospacedDigit()
                        .foregroundStyle(statusColor)
                        .contentTransition(.numericText())
                }
            }

            if window.showMeter != false, let remainingPercent {
                ProgressView(value: remainingPercent, total: 100)
                    .tint(statusColor)
                    .accessibilityLabel("\(windowTitle) remaining")
                    .accessibilityValue(MetricFormatter.percent(remainingPercent))
            }

            if let resetDate = Date.hubTimestamp(from: window.resetsAt) {
                HStack(spacing: 4) {
                    Text("Reset")
                    Text(resetDate, format: .relative(presentation: .numeric))
                }
                .font(.footnote)
                .foregroundStyle(.tertiary)
            } else if let description = nonEmpty(window.resetDescription) {
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }

            if let detail = nonEmpty(window.detail) {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var windowTitle: String {
        nonEmpty(window.label)
            ?? nonEmpty(window.kind?.capitalized)
            ?? "Quota"
    }

    private var remainingPercent: Double? {
        provider.remainingPercent(for: window)
    }

    private var headline: String? {
        if window.isCredits {
            guard let amount = window.remaining ?? provider.balance?.amount else {
                return nil
            }
            return MetricFormatter.currency(
                amount,
                sourceCode: window.currency ?? provider.balance?.currency ?? "USD",
                displayCurrency: preferences.currency
            )
        }
        if window.metric == "spend", let used = window.used {
            return MetricFormatter.currency(
                used,
                sourceCode: window.currency ?? provider.balance?.currency ?? "USD",
                displayCurrency: preferences.currency
            )
        }
        if let remainingPercent {
            return MetricFormatter.remaining(remainingPercent, locale: locale)
        }
        if let remaining = window.remaining {
            return remaining.formatted(.number.precision(.fractionLength(0...2)))
        }
        if let used = window.used {
            return used.formatted(.number.precision(.fractionLength(0...2)))
        }
        return nil
    }

    private var statusColor: Color {
        guard let remainingPercent else {
            return .primary
        }
        if remainingPercent <= 15 {
            return DesignTokens.critical
        }
        if remainingPercent <= 35 {
            return DesignTokens.warning
        }
        return ProviderPresentation.color(for: provider.provider)
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }
}
