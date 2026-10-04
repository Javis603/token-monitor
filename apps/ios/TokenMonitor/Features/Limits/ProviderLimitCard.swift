import SwiftUI

struct ProviderLimitCard: View {
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let provider: LimitProvider

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 12))
                    : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
                layout {
                    ProviderMark(provider: provider.provider)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(ProviderPresentation.displayName(for: provider.provider))
                            .font(.headline)

                        Text(provider.accountTitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .privacySensitive()
                    }

                    if !dynamicTypeSize.isAccessibilitySize { Spacer() }

                    VStack(alignment: dynamicTypeSize.isAccessibilitySize ? .leading : .trailing, spacing: 4) {
                        if let title = provider.secondaryTitle {
                            Text(title)
                                .font(.subheadline)
                                .bold()
                        }

                        if provider.status != "ok" || provider.stale == true {
                            Label(LocalizedStringKey(statusTitle), systemImage: statusSymbol)
                                .font(.footnote)
                                .foregroundStyle(statusColor)
                        } else if let updatedDate = Date.hubTimestamp(from: provider.updatedAt) {
                            Text(updatedDate.updateDescription(locale: locale))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                if provider.displayWindows.isEmpty {
                    Label(
                        LocalizedStringKey(provider.status == "not_configured"
                            ? "Not configured on reporting devices"
                            : "No quota windows available"),
                        systemImage: "gauge.open.with.lines.needle.33percent"
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                } else {
                    ForEach(provider.displayWindows) { window in
                        LimitWindowRow(provider: provider, window: window)
                            .padding(.top, 6)
                    }
                }
        }
        .padding(.vertical, 8)
    }

    private var statusTitle: String {
        if provider.stale == true {
            return "Stale"
        }
        return switch provider.status {
        case "ok": "Up to date"
        case "not_configured": "Setup needed"
        case "timeout": "Timed out"
        case "rate_limited": "Rate limited"
        case "unavailable": "Unavailable"
        default: provider.status?.capitalized ?? "Unknown"
        }
    }

    private var statusSymbol: String {
        if provider.stale == true {
            return "clock.badge.exclamationmark"
        }
        return switch provider.status {
        case "ok": "checkmark.circle.fill"
        case "not_configured": "gearshape.fill"
        default: "exclamationmark.triangle.fill"
        }
    }

    private var statusColor: Color {
        if provider.stale == true {
            return .secondary
        }
        return provider.status == "ok" ? .green : .orange
    }
}
