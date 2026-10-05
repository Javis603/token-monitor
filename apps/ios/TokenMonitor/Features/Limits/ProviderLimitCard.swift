import SwiftUI

/// Groups accounts without changing the Hub's provider or account ordering.
nonisolated struct LimitProviderGroup: Identifiable {
    let id: String
    var accounts: [LimitProvider]

    static func grouped(_ providers: [LimitProvider]) -> [LimitProviderGroup] {
        var groups: [LimitProviderGroup] = []
        var indices: [String: Int] = [:]
        for provider in providers {
            let id = provider.normalizedProviderID
            let key = id.isEmpty ? provider.id : id
            if let index = indices[key] {
                groups[index].accounts.append(provider)
            } else {
                indices[key] = groups.count
                groups.append(LimitProviderGroup(id: key, accounts: [provider]))
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
        if providers.count == 1, let provider = providers.first {
            singleAccount(provider)
        } else {
            multiAccount
        }
    }

    /// Single-account provider: name + plan on the header row, freshness under
    /// the name, then windows. No redundant account line.
    private func singleAccount(_ provider: LimitProvider) -> some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 12) {
            let layout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
            layout {
                providerName(provider)
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                planCellText(provider)
            }
            freshnessLine(provider)
            windows(for: provider)
        }
    }

    /// Multi-account group: name + "N accounts", then one divided block per
    /// account (title + plan baseline, freshness, windows).
    private var multiAccount: some View {
        VStack(alignment: .leading, spacing: compact ? 10 : 12) {
            if let first = providers.first {
                let layout = dynamicTypeSize.isAccessibilitySize
                    ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6))
                    : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 12))
                layout {
                    providerName(first)
                    if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                    Text(MetricFormatter.accountCount(providers.count, locale: locale))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(Array(providers.enumerated()), id: \.element.id) { index, provider in
                if index > 0 {
                    Divider()
                }
                LimitAccountSection(provider: provider, compact: compact)
            }
        }
    }

    private func providerName(_ provider: LimitProvider) -> some View {
        Text(ProviderPresentation.displayName(for: provider.provider))
            .font(compact ? .subheadline.weight(.semibold) : .headline)
            .padding(.leading, 32)
            .overlay(alignment: .leading) {
                ProviderMark(provider: provider.provider)
            }
            .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func planCellText(_ provider: LimitProvider) -> some View {
        let text = switch provider.planCell {
        case let .plan(plan):
            Text(plan)
        case let .status(key):
            Text(LocalizedStringKey(key))
        case nil:
            Text("")
        }
        text
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
    }

    @ViewBuilder
    private func freshnessLine(_ provider: LimitProvider) -> some View {
        if provider.showsFreshnessLine,
           let text = provider.freshnessText(locale: locale) {
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 32)
        }
    }

    @ViewBuilder
    private func windows(for provider: LimitProvider) -> some View {
        if provider.displayWindows.isEmpty {
            Text("No quota windows available")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.leading, 32)
        } else {
            LimitWindowGrid(
                provider: provider,
                windows: compact
                    ? Array(provider.displayWindows.prefix(2))
                    : provider.displayWindows
            )
        }
    }
}

private struct LimitAccountSection: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(\.locale) private var locale
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    let provider: LimitProvider
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                accountHeading
                if provider.showsFreshnessLine,
                   let text = provider.freshnessText(locale: locale) {
                    Text(text)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)

            if provider.displayWindows.isEmpty {
                Text("No quota windows available")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                LimitWindowGrid(
                    provider: provider,
                    windows: compact
                        ? Array(provider.displayWindows.prefix(2))
                        : provider.displayWindows
                )
            }
        }
    }

    private var accountHeading: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4))
            : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
        return layout {
            Text(provider.accountTitle(maskingEmails: preferences.masksAccountEmails))
                .font(.subheadline.weight(.medium))
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                .privacySensitive()
            switch provider.planCell {
            case let .plan(plan):
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                Text(plan)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
            case let .status(key):
                if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 4) }
                Text(LocalizedStringKey(key))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(dynamicTypeSize.isAccessibilitySize ? .leading : .trailing)
            case nil:
                EmptyView()
            }
        }
    }
}

extension LimitProvider {
    /// Freshness line under a provider name: "Updated …", or "Stale · …" once
    /// the report is stale; nil when the Hub sent no timestamp.
    func freshnessText(locale: Locale) -> String? {
        let isStale = stale == true
        if let date = Date.hubTimestamp(from: updatedAt) {
            return date.limitFreshnessDescription(stale: isStale, locale: locale)
        }
        return isStale ? Date.staleWord(for: locale) : nil
    }
}
