import SwiftUI

/// Groups accounts without changing the Hub's provider or account ordering.
nonisolated struct LimitProviderGroup: Identifiable {
    let id: String
    var accounts: [LimitProvider]

    static func grouped(_ providers: [LimitProvider]) -> [LimitProviderGroup] {
        var groups: [LimitProviderGroup] = []
        var indices: [String: Int] = [:]
        for provider in providers {
            let key = provider.provider?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let id = key.flatMap { $0.isEmpty ? nil : $0 } ?? provider.id
            if let index = indices[id] {
                groups[index].accounts.append(provider)
            } else {
                indices[id] = groups.count
                groups.append(LimitProviderGroup(id: id, accounts: [provider]))
            }
        }
        return groups
    }
}

struct ProviderLimitCard: View {
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let providers: [LimitProvider]
    var compact = false

    init(provider: LimitProvider) {
        providers = [provider]
    }

    init(providers: [LimitProvider], compact: Bool = false) {
        self.providers = providers
        self.compact = compact
    }

    var body: some View {
        if let first = providers.first {
            VStack(alignment: .leading, spacing: 12) {
                header(for: first)

                ForEach(Array(providers.enumerated()), id: \.element.id) { index, provider in
                    if index > 0 {
                        Divider()
                            .padding(.vertical, 2)
                    }
                    LimitAccountSection(
                        provider: provider,
                        showsPlan: providers.count > 1,
                        compact: compact
                    )
                }
            }
        }
    }

    private func header(for provider: LimitProvider) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
        return layout {
            Text(ProviderPresentation.displayName(for: provider.provider))
                .font(compact ? .subheadline.weight(.semibold) : .headline)
                .padding(.leading, 32)
                .overlay(alignment: .leading) {
                    ProviderMark(provider: provider.provider)
                }
                .accessibilityAddTraits(.isHeader)
            if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
            if providers.count > 1 {
                Text(MetricFormatter.accountCount(providers.count, locale: locale))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else if let plan = provider.secondaryTitle {
                Text(plan)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
            }
        }
    }
}

private struct LimitAccountSection: View {
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let provider: LimitProvider
    let showsPlan: Bool
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                accountHeading
                if let updatedDate = Date.hubTimestamp(from: provider.updatedAt) {
                    Text(updatedDate.updateDescription(locale: locale))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if provider.status != "ok" || provider.stale == true {
                    Label(LocalizedStringKey(statusTitle), systemImage: statusSymbol)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)

            if provider.displayWindows.isEmpty {
                Label(
                    LocalizedStringKey(provider.status == "not_configured"
                        ? "Not configured on reporting devices"
                        : "No quota windows available"),
                    systemImage: "gauge.open.with.lines.needle.33percent"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            } else {
                LimitWindowGrid(
                    provider: provider,
                    windows: compact ? Array(provider.displayWindows.prefix(2)) : provider.displayWindows
                )
            }
        }
    }

    private var accountHeading: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        return layout {
            Text(provider.accountTitle)
                .font(.subheadline.weight(showsPlan ? .medium : .regular))
                .foregroundStyle(showsPlan ? .primary : .secondary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                .privacySensitive()
            if showsPlan, let plan = provider.secondaryTitle {
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                Text(plan)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
            }
        }
    }

    private var statusTitle: String {
        if provider.stale == true { return "Stale" }
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
        if provider.stale == true { return "clock.badge.exclamationmark" }
        return switch provider.status {
        case "ok": "checkmark.circle.fill"
        case "not_configured": "gearshape.fill"
        default: "exclamationmark.triangle.fill"
        }
    }
}
