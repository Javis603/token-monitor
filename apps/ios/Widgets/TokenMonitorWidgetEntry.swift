import WidgetKit
import Foundation

struct TokenMonitorWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: TokenMonitorSharedPayload.Snapshot?
    let preferences: TokenMonitorSharedPayload.Preferences
    let configuration: TokenMonitorWidgetIntent

    var content: String {
        configuration.content == .appDefault
            ? preferences.widgetContent
            : configuration.content.rawValue
    }

    var period: String {
        configuration.period == .appDefault
            ? preferences.widgetPeriod
            : configuration.period.rawValue
    }

    var providerID: String? {
        let selected = configuration.provider?.id ?? preferences.widgetProviderID
        return selected.flatMap { $0.isEmpty ? nil : $0 }
    }

    var showsCost: Bool {
        switch configuration.costVisibility {
        case .appDefault:
            preferences.widgetShowsCost
        case .show:
            true
        case .hide:
            false
        }
    }

    var showsUpdateTime: Bool {
        switch configuration.updateTimeVisibility {
        case .appDefault:
            preferences.widgetShowsUpdateTime
        case .show:
            true
        case .hide:
            false
        }
    }

    var usage: TokenMonitorSharedPayload.Usage {
        snapshot?.usage(for: period) ?? .empty
    }

    var preferredLimit: TokenMonitorSharedPayload.Limit? {
        if let providerID {
            // A missing configured provider must not silently show another account.
            return snapshot?.limits.first { $0.providerID == providerID }
        }
        return snapshot?.limits.min { lhs, rhs in
            let left = lhs.windows.compactMap(\.remainingPercent).min() ?? 101
            let right = rhs.windows.compactMap(\.remainingPercent).min() ?? 101
            return left < right
        }
    }

    // A snapshot is historical data, never evidence of an active connection.
    static let freshnessInterval: TimeInterval = 15 * 60

    var freshnessDate: Date? {
        let updated = content == "limits" ? preferredLimit?.updatedAt : snapshot?.updatedAt
        return updated?.addingTimeInterval(Self.freshnessInterval)
    }

    var isStale: Bool {
        if content == "limits" {
            if preferredLimit?.sourceStale == true { return true }
        } else if snapshot?.sourceStale == true { return true }
        guard let freshnessDate else { return snapshot != nil }
        return date >= freshnessDate
    }

    var currencyCode: String {
        preferences.currencyCode ?? "USD"
    }

    var locale: Locale {
        let languageCode = preferences.languageCode ?? "auto"
        return languageCode == "auto"
            ? .autoupdatingCurrent
            : Locale(identifier: languageCode)
    }
}

extension TokenMonitorWidgetEntry {
    static var placeholder: TokenMonitorWidgetEntry {
        TokenMonitorWidgetEntry(
            date: .now,
            snapshot: TokenMonitorSharedPayload.Snapshot(
                updatedAt: .now,
                today: TokenMonitorSharedPayload.Usage(
                    tokens: 2_480_000,
                    cost: 18.42,
                    cacheReadTokens: 1_060_000,
                    outputTokens: 182_000,
                    tools: [
                        .init(id: "codex", value: 1_380_000),
                        .init(id: "claude", value: 760_000)
                    ],
                    models: [
                        .init(id: "gpt-5.4", value: 1_380_000),
                        .init(id: "claude-opus-4.6", value: 760_000)
                    ]
                ),
                month: .empty,
                allTime: .empty,
                limits: [
                    .init(
                        id: "codex",
                        providerID: "codex",
                        planLabel: nil,
                        status: nil,
                        updatedAt: .now,
                        windows: [
                            .init(
                                id: "session",
                                label: "Session",
                                remainingPercent: 82,
                                amount: nil,
                                currency: nil,
                                resetAt: .now.addingTimeInterval(5_400)
                            ),
                            .init(
                                id: "weekly",
                                label: "Weekly",
                                remainingPercent: 46,
                                amount: nil,
                                currency: nil,
                                resetAt: .now.addingTimeInterval(172_800)
                            )
                        ]
                    )
                ],
                activity: (0..<35).map { index in
                    .init(
                        date: "2026-07-\(String(format: "%02d", max(1, 31 - index)))",
                        tokens: Double((index * 431_771) % 2_700_000),
                        cost: Double(index % 9)
                    )
                }
            ),
            preferences: .default,
            configuration: TokenMonitorWidgetIntent()
        )
    }
}
