import ActivityKit
import Foundation

// ContentState v4 mirrors `src/shared/liveActivity.js` — data only, with null
// fields omitted to stay inside ActivityKit's 4 KB push budget. Every
// presentation choice lives in `LiveActivityLayout`, which the widget extension
// reads from the app group, so a new layout option never needs a Hub change.
// Dates are seconds since the 2001-01-01 Cocoa reference date (the standard
// Codable `Date` encoding, which is what `aps.timestamp` uses).
nonisolated struct TokenMonitorActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var updatedAt: Date
        var sourceStale: Bool?
        var usage: Usage
        /// The most recently used client and its own share of each period.
        var recent: Recent?
        /// The three most constrained records, then the providers and accounts
        /// the layout names, then the recent client's records.
        var quotas: [Quota]
        var agents: Agents

        struct Usage: Codable, Hashable, Sendable {
            var today: PeriodUsage
            var month: PeriodUsage
        }

        struct PeriodUsage: Codable, Hashable, Sendable {
            var tokens: Double?
            var costUSD: Double?
            /// Timed output tokens per second; nil when the period has no timed output.
            var outputTPS: Double?
        }

        struct Recent: Codable, Hashable, Sendable {
            var client: String
            var today: PeriodUsage
            var month: PeriodUsage
        }

        struct Quota: Codable, Hashable, Sendable {
            var providerID: String
            var accountKey: String?
            var planLabel: String?
            var updatedAt: Date?
            var stale: Bool?
            /// Canonical (non-additional) windows, display order, at most three.
            var windows: [Window]
        }

        struct Window: Codable, Hashable, Sendable {
            var label: String
            /// `session`, `daily`, `weekly` or `billing` when the collector reports it.
            var kind: String?
            var remainingPercent: Double?
            var resetsAt: Date?
            var windowMinutes: Double?
            var creditsAmount: Double?
            var creditsCurrency: String?
        }

        struct Agents: Codable, Hashable, Sendable {
            /// Sessions currently running (the Sessions list's three-state rule).
            var running: Int
            /// Distinct client ids of those sessions, most recent first, at most three.
            var clients: [String]

            static let none = Agents(running: 0, clients: [])
        }
    }

    let title: String
}

/// Device-side Live Activity presentation, persisted in the shared app-group
/// preferences. Like the desktop menu bar, each surface pairs an appearance
/// with a data source; colour, type and wording follow the design system.
/// Every field decodes leniently: a missing or unknown value falls back to its
/// default instead of discarding the whole layout.
nonisolated struct LiveActivityLayout: Codable, Hashable, Sendable {
    /// Where a reading comes from, as in the desktop menu bar composer.
    struct Source: Codable, Hashable, Sendable {
        enum Automatic: String, Codable, CaseIterable, Sendable {
            /// The lowest remaining matching quota.
            case lowest
            /// The most recently used AI tool.
            case recent
        }

        enum Window: String, Codable, CaseIterable, Sendable {
            case primary, secondary, session, daily, weekly, billing
        }

        enum Value: String, Codable, CaseIterable, Sendable {
            case remaining, used
        }

        enum Period: String, Codable, CaseIterable, Sendable {
            case today, month
        }

        /// Tokens and cost across every tool, or only the most recently used one.
        enum Scope: String, Codable, CaseIterable, Sendable {
            case all, recent
        }

        /// nil chooses automatically by `automatic`.
        var providerID: String?
        var automatic: Automatic = .lowest
        /// nil picks the provider's lowest-remaining account.
        var accountKey: String?
        var window: Window = .primary
        var value: Value = .remaining
        var period: Period = .today
        var scope: Scope = .all

        init(providerID: String? = nil, automatic: Automatic = .lowest, accountKey: String? = nil,
             window: Window = .primary, value: Value = .remaining, period: Period = .today, scope: Scope = .all) {
            self.providerID = providerID
            self.automatic = automatic
            self.accountKey = accountKey
            self.window = window
            self.value = value
            self.period = period
            self.scope = scope
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            func value<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T {
                ((try? values.decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
            }
            providerID = (try? values.decodeIfPresent(String.self, forKey: .providerID)) ?? nil
            automatic = value(.automatic, .lowest)
            accountKey = (try? values.decodeIfPresent(String.self, forKey: .accountKey)) ?? nil
            window = value(.window, .primary)
            self.value = value(.value, .remaining)
            period = value(.period, .today)
            scope = value(.scope, .all)
        }

        private enum CodingKeys: String, CodingKey {
            case providerID, automatic, accountKey, window, value, period, scope
        }
    }

    enum CompactStyle: String, Codable, CaseIterable, Sendable {
        case ring, providerIcon, appIcon, percent, percentReset, reset, tokens, cost, speed, agents, none
    }

    /// Shown when another app's activity shares the island.
    enum MinimalStyle: String, Codable, CaseIterable, Sendable {
        case appRing, ring, percent, providerIcon
    }

    enum ExpandedTemplate: String, Codable, CaseIterable, Sendable {
        case quota, usage, providers
    }

    enum LockScreenTemplate: String, Codable, CaseIterable, Sendable {
        case overview, quota
    }

    struct Slot: Codable, Hashable, Sendable {
        var style: CompactStyle
        var source = Source()

        init(style: CompactStyle, source: Source = Source()) {
            self.style = style
            self.source = source
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            style = ((try? values.decodeIfPresent(CompactStyle.self, forKey: .style)) ?? nil) ?? .none
            source = ((try? values.decodeIfPresent(Source.self, forKey: .source)) ?? nil) ?? Source()
        }

        private enum CodingKeys: String, CodingKey { case style, source }
    }

    var compactLeading = Slot(style: .ring)
    var compactTrailing = Slot(style: .percent)
    var minimal: MinimalStyle = .appRing
    var minimalSource = Source()
    var expanded: ExpandedTemplate = .quota
    var expandedSource = Source()
    var lockScreen: LockScreenTemplate = .overview
    var lockScreenSource = Source()

    init() {}

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        func value<T: Decodable>(_ key: CodingKeys, _ fallback: T) -> T {
            ((try? values.decodeIfPresent(T.self, forKey: key)) ?? nil) ?? fallback
        }
        let defaults = LiveActivityLayout()
        compactLeading = value(.compactLeading, defaults.compactLeading)
        compactTrailing = value(.compactTrailing, defaults.compactTrailing)
        minimal = value(.minimal, defaults.minimal)
        minimalSource = value(.minimalSource, defaults.minimalSource)
        expanded = value(.expanded, defaults.expanded)
        expandedSource = value(.expandedSource, defaults.expandedSource)
        lockScreen = value(.lockScreen, defaults.lockScreen)
        lockScreenSource = value(.lockScreenSource, defaults.lockScreenSource)
    }

    private enum CodingKeys: String, CodingKey {
        case compactLeading, compactTrailing, minimal, minimalSource
        case expanded, expandedSource, lockScreen, lockScreenSource
    }

    private var sources: [Source] {
        [compactLeading.source, compactTrailing.source, minimalSource, expandedSource, lockScreenSource]
    }

    /// Providers the layout names explicitly; the Hub sends them beside the ranked records.
    var referencedProviderIDs: [String] {
        var ids: [String] = []
        for id in sources.compactMap(\.providerID) where !ids.contains(id) { ids.append(id) }
        return ids
    }

    var referencedAccountKeys: [String] {
        var keys: [String] = []
        for key in sources.compactMap(\.accountKey) where !keys.contains(key) { keys.append(key) }
        return keys
    }
}
