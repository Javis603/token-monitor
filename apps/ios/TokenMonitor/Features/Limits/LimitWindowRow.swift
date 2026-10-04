import SwiftUI

struct LimitWindowRow: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let provider: LimitProvider
    let window: LimitWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 5))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
            layout {
                Text(LocalizedStringKey(windowTitle))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                if !dynamicTypeSize.isAccessibilitySize { Spacer() }

                if let headline {
                    Text(headline)
                        .bold()
                        .monospacedDigit()
                        .foregroundStyle(statusColor)
                        .contentTransition(.numericText())
                }
            }

            if window.showMeter != false, let remainingPercent {
                ProgressView(value: min(100, max(0, remainingPercent)), total: 100)
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
                .foregroundStyle(.secondary)
            } else if let description = nonEmpty(window.resetDescription) {
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
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
        window.displayLabel(providerID: provider.provider)
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
        return DesignTokens.accent
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }
}
