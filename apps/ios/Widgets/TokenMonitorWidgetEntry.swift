import SwiftUI
import WidgetKit
import Foundation

/// Resolved ink choice — the widget intent's contrast option, decoupled from
/// AppIntents so the app target can build previews.
enum WidgetInk {
    case recommended
    case light
    case dark
}

/// One render-ready timeline entry. Intent resolution lives in
/// `TokenMonitorWidgetEntry+Intent.swift` (widget target only); every value
/// here is already concrete so the app can render the same view as a preview.
struct TokenMonitorWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: TokenMonitorSharedPayload.Snapshot?
    let preferences: TokenMonitorSharedPayload.Preferences
    let content: String
    let period: String
    let providerID: String?
    let showsCost: Bool
    let showsUpdateTime: Bool
    let ink: WidgetInk

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

    /// Reported activity days with usable token readings, oldest first. The
    /// live `today` usage wins over daily history, which can lag behind by a
    /// day — otherwise today's bar or Today stat can read as absent while the
    /// headline shows a live total.
    var days: [TokenMonitorSharedPayload.Day] {
        var days = (snapshot?.activity ?? [])
            .filter { !$0.date.isEmpty && $0.tokens.isFinite && $0.tokens >= 0 }
            .sorted { $0.date < $1.date }
        guard let today = snapshot?.today,
              today.tokens.isFinite, today.tokens >= 0,
              today.tokensKnown != false else { return days }
        let key = WidgetActivityModel.dayKey(for: date)
        let cost = today.cost.isFinite
            ? today.cost
            : (days.first { $0.date == key }?.cost ?? 0)
        let day = TokenMonitorSharedPayload.Day(date: key, tokens: today.tokens, cost: cost)
        if let index = days.firstIndex(where: { $0.date == key }) {
            days[index] = day
        } else {
            days.append(day)
        }
        return days
    }

    var visibleLimitWindows: [TokenMonitorSharedPayload.LimitWindow] {
        preferredLimit?.windows.filter {
            $0.remainingPercent?.isFinite == true || $0.amount?.isFinite == true
        } ?? []
    }

    /// Automatic limits pick the most constrained account first, then keep the
    /// Hub's remaining order — the user's own Limits order.
    var orderedLimits: [TokenMonitorSharedPayload.Limit] {
        guard providerID == nil, let snapshot else {
            return preferredLimit.map { [$0] } ?? []
        }
        let rest = snapshot.limits.filter { $0.id != preferredLimit?.id }
        return (preferredLimit.map { [$0] } ?? []) + rest
    }

    var hasData: Bool {
        guard snapshot != nil else { return false }
        switch content {
        case "limits":
            return !visibleLimitWindows.isEmpty
        case "activity":
            return !days.isEmpty
        default:
            return usage.tokensKnown != false && usage.tokens.isFinite
        }
    }

    var dataDate: Date? {
        content == "limits" ? preferredLimit?.updatedAt : snapshot?.updatedAt
    }

    // A snapshot is historical data, never evidence of an active connection.
    static let freshnessInterval: TimeInterval = 15 * 60

    var freshnessDate: Date? {
        dataDate?.addingTimeInterval(Self.freshnessInterval)
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
            : ActivityContext.locale(for: languageCode)
    }

    var periodTitle: LocalizedStringKey {
        switch period {
        case "month": "This month"
        case "allTime": "All time"
        default: "Today"
        }
    }
}

extension TokenMonitorWidgetEntry {
    /// Illustrative snapshot for the widget's own placeholder and the Settings
    /// preview when the Hub has not published one yet.
    static let placeholderSnapshot = TokenMonitorSharedPayload.Snapshot(
        updatedAt: .now,
        today: TokenMonitorSharedPayload.Usage(
            tokens: 2_480_000,
            cost: 18.42,
            cacheReadTokens: 1_060_000,
            outputTokens: 182_000,
            tools: [
                .init(id: "codex", value: 1_380_000),
                .init(id: "claude", value: 760_000),
                .init(id: "opencode", value: 210_000),
                .init(id: "gemini", value: 96_000),
                .init(id: "cursor", value: 34_000)
            ],
            models: [
                .init(id: "gpt-5.4", value: 1_380_000),
                .init(id: "claude-opus-4.6", value: 620_000),
                .init(id: "claude-sonnet-4.6", value: 140_000),
                .init(id: "gemini-3-pro", value: 96_000),
                .init(id: "gpt-5.4-mini", value: 244_000)
            ],
            tokensKnown: true,
            costKnown: true,
            tokenComponentsKnown: true,
            throughputKnown: true,
            unclassifiedTokens: 120_000,
            outputTokensPerSecond: 62
        ),
        month: TokenMonitorSharedPayload.Usage(
            tokens: 41_600_000,
            cost: 286.15,
            cacheReadTokens: 17_200_000,
            outputTokens: 3_400_000,
            tools: [
                .init(id: "codex", value: 24_900_000),
                .init(id: "claude", value: 12_700_000),
                .init(id: "opencode", value: 2_600_000),
                .init(id: "gemini", value: 980_000),
                .init(id: "cursor", value: 420_000)
            ],
            models: [
                .init(id: "gpt-5.4", value: 24_900_000),
                .init(id: "claude-opus-4.6", value: 9_800_000),
                .init(id: "claude-sonnet-4.6", value: 2_900_000),
                .init(id: "gemini-3-pro", value: 980_000),
                .init(id: "gpt-5.4-mini", value: 3_020_000)
            ],
            tokensKnown: true,
            costKnown: true,
            tokenComponentsKnown: true,
            throughputKnown: true,
            unclassifiedTokens: 2_100_000,
            outputTokensPerSecond: 58
        ),
        allTime: TokenMonitorSharedPayload.Usage(
            tokens: 128_400_000,
            cost: 902.60,
            cacheReadTokens: 51_300_000,
            outputTokens: 11_200_000,
            tools: [
                .init(id: "codex", value: 72_500_000),
                .init(id: "claude", value: 41_800_000),
                .init(id: "opencode", value: 8_100_000),
                .init(id: "gemini", value: 4_200_000),
                .init(id: "cursor", value: 1_800_000)
            ],
            models: [
                .init(id: "gpt-5.4", value: 72_500_000),
                .init(id: "claude-opus-4.6", value: 31_900_000),
                .init(id: "claude-sonnet-4.6", value: 9_900_000),
                .init(id: "gemini-3-pro", value: 4_200_000),
                .init(id: "gpt-5.4-mini", value: 9_900_000)
            ],
            tokensKnown: true,
            costKnown: true,
            tokenComponentsKnown: true,
            throughputKnown: true,
            unclassifiedTokens: 6_400_000,
            outputTokensPerSecond: 54
        ),
        limits: [
            .init(
                id: "codex",
                providerID: "codex",
                planLabel: "Pro",
                status: nil,
                updatedAt: .now,
                windows: [
                    .init(
                        id: "session",
                        label: "Session",
                        remainingPercent: 82,
                        amount: nil,
                        currency: nil,
                        resetAt: .now.addingTimeInterval(6_720)
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
            ),
            .init(
                id: "claude",
                providerID: "claude",
                planLabel: "Max 5×",
                status: nil,
                updatedAt: .now,
                windows: [
                    .init(
                        id: "session",
                        label: "Session",
                        remainingPercent: 63,
                        amount: nil,
                        currency: nil,
                        resetAt: .now.addingTimeInterval(9_300)
                    ),
                    .init(
                        id: "weekly",
                        label: "Weekly",
                        remainingPercent: 28,
                        amount: nil,
                        currency: nil,
                        resetAt: .now.addingTimeInterval(345_600)
                    )
                ]
            ),
            .init(
                id: "openrouter",
                providerID: "openrouter",
                planLabel: nil,
                status: nil,
                updatedAt: .now,
                windows: [
                    .init(
                        id: "credits",
                        label: "Credits",
                        remainingPercent: nil,
                        amount: 12.40,
                        currency: "USD",
                        resetAt: nil,
                        kind: "credits"
                    )
                ]
            )
        ],
        activity: sampleActivity()
    )

    static var placeholder: TokenMonitorWidgetEntry {
        TokenMonitorWidgetEntry(
            date: .now,
            snapshot: placeholderSnapshot,
            preferences: .default,
            content: "overview",
            period: "today",
            providerID: nil,
            showsCost: true,
            showsUpdateTime: true,
            ink: .recommended
        )
    }

    /// ~150 days ending today: weekday-heavy totals, a few measured zero days
    /// and a couple of absent days so every cell state shows.
    private static func sampleActivity(now: Date = .now) -> [TokenMonitorSharedPayload.Day] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let today = calendar.startOfDay(for: now)
        var days: [TokenMonitorSharedPayload.Day] = []
        for index in 0..<150 {
            // 3 and 41 days ago are absent from the report.
            if index == 3 || index == 41 { continue }
            guard let date = calendar.date(byAdding: .day, value: -index, to: today) else { continue }
            let weekday = calendar.component(.weekday, from: date)
            // Same order of magnitude as the usage periods; today matches the
            // 2.48M today reading exactly.
            var tokens = 1_200_000 + Double((index * 7919) % 19) * 140_000
            if weekday == 1 || weekday == 7 { tokens *= 0.65 }
            // A measured zero every couple of weeks, plus today and yesterday.
            if index == 11 || index == 33 || index == 90 { tokens = 0 }
            if index == 0 { tokens = 2_480_000 }
            let key = WidgetActivityModel.dayKey(for: date)
            days.append(.init(date: key, tokens: tokens, cost: tokens / 140_000))
        }
        return days.sorted { $0.date < $1.date }
    }
}
