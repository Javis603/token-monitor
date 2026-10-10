import SwiftUI

struct LimitWindowRow: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let provider: LimitProvider
    let window: LimitWindow
    var stacksHeadline = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if dynamicTypeSize.isAccessibilitySize || stacksHeadline {
                VStack(alignment: .leading, spacing: 4) {
                    title
                    value
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    title.fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 4)
                    value.fixedSize(horizontal: true, vertical: false)
                }
            }

            if window.showMeter != false, let remainingPercent {
                let color = ProviderPresentation.color(for: provider.provider)
                GeometryReader { geometry in
                    Capsule()
                        .fill(color.opacity(0.14))
                        .overlay(alignment: .leading) {
                            Capsule()
                                .fill(color.opacity(window.kind == "session" || window.kind == "daily" ? 0.95 : 0.68))
                                .frame(width: geometry.size.width * min(100, max(0, remainingPercent)) / 100)
                        }
                }
                .frame(height: 6)
                .accessibilityHidden(true)
            }

            if Date.hubTimestamp(from: window.resetsAt) != nil
                || nonEmpty(window.resetDescription) != nil
                || monetaryDetail != nil {
                let detailLayout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                detailLayout {
                    if let resetDate = Date.hubTimestamp(from: window.resetsAt) {
                        HStack(spacing: 4) {
                            Text(verbatim: "Reset")
                            TimelineView(.periodic(from: .now, by: 60)) { context in
                                Text(MetricFormatter.limitCountdown(to: resetDate, now: context.date, locale: MetricFormatter.desktopQuotaLocale))
                                    .monospacedDigit()
                            }
                        }
                    } else if let description = nonEmpty(window.resetDescription) {
                        Text(description)
                    }
                    if let monetaryDetail {
                        if !dynamicTypeSize.isAccessibilitySize {
                            Spacer(minLength: 4)
                        }
                        Text(verbatim: monetaryDetail)
                            .monospacedDigit()
                    }
                }
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
        if (provider.normalizedProviderID == "commandcode" || provider.normalizedProviderID == "zed"),
           window.kind == "billing", window.showMeter != false,
           let remainingPercent {
            return MetricFormatter.remaining(remainingPercent, locale: MetricFormatter.desktopQuotaLocale)
        }
        if window.isCredits {
            guard let amount = window.remaining ?? provider.balance?.amount else {
                return nil
            }
            return MetricFormatter.currency(amount, code: sourceCurrency)
        }
        if window.metric == "spend", let used = window.used {
            return MetricFormatter.currency(used, code: sourceCurrency)
        }
        if let remainingPercent {
            return MetricFormatter.remaining(remainingPercent, locale: MetricFormatter.desktopQuotaLocale)
        }
        if let remaining = window.remaining {
            return remaining.formatted(.number.precision(.fractionLength(0...2)))
        }
        if let used = window.used {
            return used.formatted(.number.precision(.fractionLength(0...2)))
        }
        return nil
    }

    private var sourceCurrency: String {
        window.currency ?? provider.balance?.currency ?? "USD"
    }

    private var monetaryDetail: String? {
        guard window.kind == "billing", let limit = window.limit, limit > 0 else {
            return nil
        }
        switch provider.normalizedProviderID {
        case "commandcode":
            guard let remaining = window.remaining else { return nil }
            return "\(MetricFormatter.currency(remaining, code: sourceCurrency)) / \(MetricFormatter.currency(limit, code: sourceCurrency))"
        case "zed":
            guard window.limitId != "zed.edit-predictions", let used = window.used else { return nil }
            return "\(MetricFormatter.currency(used, code: sourceCurrency)) / \(MetricFormatter.currency(limit, code: sourceCurrency))"
        default:
            return nil
        }
    }

    private var title: some View {
        Text(verbatim: windowTitle)
            .font(dynamicTypeSize.isAccessibilitySize ? .body : .caption)
            .foregroundStyle(.secondary)
    }

    private var value: some View {
        Text(headline ?? "—")
            .font(dynamicTypeSize.isAccessibilitySize ? .body.weight(.semibold) : .caption.weight(.medium))
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
        VStack(alignment: .leading, spacing: 16) {
            ForEach(LimitWindowSection.make(provider: provider, windows: windows)) { section in
                VStack(alignment: .leading, spacing: 8) {
                    if let title = section.title {
                        Text(title)
                            .font(.subheadline.weight(.medium))
                            .accessibilityAddTraits(.isHeader)
                    }
                    VStack(alignment: .leading, spacing: 16) {
                        ForEach(Array(section.rows.enumerated()), id: \.offset) { _, row in
                            if dynamicTypeSize.isAccessibilitySize {
                                VStack(alignment: .leading, spacing: 16) {
                                    ForEach(row) { window in
                                        LimitWindowRow(provider: provider, window: window)
                                    }
                                }
                            } else {
                                // Fit the pair together, keeping both meters on one baseline.
                                ViewThatFits(in: .horizontal) {
                                    windowPair(row, stacksHeadline: false)
                                    windowPair(row, stacksHeadline: true)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    private func windowPair(_ row: [LimitWindow], stacksHeadline: Bool) -> some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(row) { window in
                LimitWindowRow(provider: provider, window: window, stacksHeadline: stacksHeadline)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
            }
        }
    }
}
