import ActivityKit
import Foundation

// ContentState v2 mirrors `src/shared/liveActivity.js` — structured data on the
// wire; the extension formats and localises. Dates are seconds since the
// 2001-01-01 Cocoa reference date (the standard Codable `Date` encoding, which
// is what `aps.timestamp` uses).
nonisolated struct TokenMonitorActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable, Sendable {
        var updatedAt: Date
        var sourceStale: Bool?
        var period: String          // "today" | "month" | "allTime"
        var tokens: Double?
        var costUSD: Double?
        var quota: Quota?
        var layout: Layout

        struct Quota: Codable, Hashable, Sendable {
            var providerID: String
            var planLabel: String?
            var updatedAt: Date?
            var stale: Bool?
            /// Canonical (non-additional) windows, display order, at most two.
            var windows: [Window]
        }

        struct Window: Codable, Hashable, Sendable {
            var label: String
            var remainingPercent: Double?
            var resetsAt: Date?
            var creditsAmount: Double?
            var creditsCurrency: String?
        }

        struct Layout: Codable, Hashable, Sendable {
            var compactLeading: String   // "mark" | "ring" | "tokens" | "cost"
            var compactTrailing: String  // "percent" | "reset" | "tokens" | "cost" | "ring"
            var expanded: String         // "quota" | "usage" | "combined"
            var lockScreen: String       // "quota" | "usage" | "combined"
            var currencyCode: String     // USD | TWD | HKD | CNY
            var languageCode: String     // auto | en | zh-TW | zh-CN | ja | ko

            var compactLeadingOption: CompactLeadingOption {
                CompactLeadingOption(rawValue: compactLeading) ?? .mark
            }
            var compactTrailingOption: CompactTrailingOption {
                CompactTrailingOption(rawValue: compactTrailing) ?? .percent
            }
            var expandedStyle: SurfaceStyle {
                SurfaceStyle(rawValue: expanded) ?? .quota
            }
            var lockScreenStyle: SurfaceStyle {
                SurfaceStyle(rawValue: lockScreen) ?? .combined
            }
        }

        enum CompactLeadingOption: String, CaseIterable, Sendable {
            case mark, ring, tokens, cost
        }

        enum CompactTrailingOption: String, CaseIterable, Sendable {
            case percent, reset, tokens, cost, ring
        }

        enum SurfaceStyle: String, CaseIterable, Sendable {
            case quota, usage, combined
        }
    }

    let title: String
}
