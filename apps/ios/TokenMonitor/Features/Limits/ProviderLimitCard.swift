import SwiftUI

struct ProviderLimitCard: View {
    @Environment(\.locale) private var locale

    let provider: LimitProvider

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ProviderMark(provider: provider.provider)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(ProviderPresentation.displayName(for: provider.provider))
                            .font(.headline)

                        Text(provider.accountTitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .privacySensitive()
                    }

                    Spacer()

                    VStack(alignment: .trailing, spacing: 2) {
                        if let title = provider.secondaryTitle {
                            Text(title)
                                .font(.subheadline)
                                .bold()
                        }

                        if provider.status != "ok" || provider.stale == true {
                            Label(statusTitle, systemImage: statusSymbol)
                                .font(.footnote)
                                .foregroundStyle(statusColor)
                        } else if let updatedDate = Date.hubTimestamp(from: provider.updatedAt) {
                            Text(updatedDate.updateDescription(locale: locale))
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }

                if provider.displayWindows.isEmpty {
                    Label(
                        provider.status == "not_configured"
                            ? "Not configured on reporting devices"
                            : "No quota windows available",
                        systemImage: "gauge.open.with.lines.needle.33percent"
                    )
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                } else {
                    if pairedWindows.count == 2 {
                        HStack(alignment: .top, spacing: 20) {
                            ForEach(pairedWindows) { window in
                                LimitWindowRow(provider: provider, window: window)
                                    .frame(maxWidth: .infinity, alignment: .topLeading)
                            }
                        }
                    } else {
                        ForEach(pairedWindows) { window in
                            LimitWindowRow(provider: provider, window: window)
                        }
                    }

                    ForEach(remainingWindows) { window in
                        Divider()
                        LimitWindowRow(provider: provider, window: window)
                    }
                }
        }
        .padding(.vertical, 8)
    }

    private var visibleWindows: [LimitWindow] {
        Array(provider.displayWindows.prefix(4))
    }

    private var pairedWindows: [LimitWindow] {
        Array(visibleWindows.filter { !$0.isCredits && $0.metric != "spend" }.prefix(2))
    }

    private var remainingWindows: [LimitWindow] {
        visibleWindows.filter { window in
            !pairedWindows.contains(where: { $0.id == window.id })
        }
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
