import SwiftUI

struct LimitWindowRow: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let provider: LimitProvider
    let window: LimitWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if dynamicTypeSize.isAccessibilitySize {
                VStack(alignment: .leading, spacing: 4) {
                    title
                    value
                }
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .firstTextBaseline, spacing: 4) {
                        title.fixedSize(horizontal: true, vertical: false)
                        Spacer(minLength: 4)
                        value.fixedSize(horizontal: true, vertical: false)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        title
                        value
                    }
                }
            }

            if window.showMeter != false, let remainingPercent {
                let color = ProviderPresentation.color(for: provider.provider)
                GeometryReader { geometry in
                    Capsule()
                        .fill(color.opacity(0.14))
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(color)
                                .frame(width: geometry.size.width * min(100, max(0, remainingPercent)) / 100)
                        }
                }
                .frame(height: 6)
                .accessibilityHidden(true)
            }

            if let resetDate = Date.hubTimestamp(from: window.resetsAt) {
                HStack(spacing: 4) {
                    Text("Reset")
                    Text(resetDate, format: .relative(presentation: .numeric))
                }
                .font(dynamicTypeSize.isAccessibilitySize ? .footnote : .caption2)
                .foregroundStyle(.secondary)
            } else if let description = nonEmpty(window.resetDescription) {
                Text(description)
                    .font(dynamicTypeSize.isAccessibilitySize ? .footnote : .caption2)
                    .foregroundStyle(.secondary)
            }

            if let detail = nonEmpty(window.detail) {
                Text(detail)
                    .font(dynamicTypeSize.isAccessibilitySize ? .footnote : .caption2)
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

    private var title: some View {
        Text(LocalizedStringKey(windowTitle))
            .font(dynamicTypeSize.isAccessibilitySize ? .subheadline : .caption)
            .foregroundStyle(.secondary)
    }

    private var value: some View {
        Text(headline ?? "—")
            .font(dynamicTypeSize.isAccessibilitySize ? .subheadline.weight(.semibold) : .caption.weight(.semibold))
            .monospacedDigit()
            .foregroundStyle(.primary)
            .contentTransition(.numericText())
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.isEmpty else {
            return nil
        }
        return value
    }
}

/// Desktop quota windows read across a row; accessibility text gets the full width.
struct LimitWindowGrid: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let provider: LimitProvider
    let windows: [LimitWindow]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 12) {
            ForEach(windows) { window in
                LimitWindowRow(provider: provider, window: window)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }

    private var columns: [GridItem] {
        let count = dynamicTypeSize.isAccessibilitySize || windows.count == 1 ? 1 : 2
        return Array(repeating: GridItem(.flexible(minimum: 0), spacing: 12, alignment: .top), count: count)
    }
}
