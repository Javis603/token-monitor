import Foundation

/// Optional authenticated Hub data; an absent count is not a reported zero.
nonisolated struct ProviderResetCredits: Decodable, Sendable {
    var availableCount: Double? = nil
    var nextExpiresAt: String? = nil
    var expirations: [String]? = nil
    var grants: [ProviderResetGrant]? = nil

    var visibleCount: Int? {
        guard let availableCount, availableCount.isFinite,
              availableCount >= 1, availableCount < Double(Int.max) else { return nil }
        return Int(availableCount.rounded(.down))
    }

    var expirationDates: [Date] {
        let dates = (expirations ?? []).compactMap { Date.hubTimestamp(from: $0) }.sorted()
        if !dates.isEmpty { return dates }
        return Date.hubTimestamp(from: nextExpiresAt).map { [$0] } ?? []
    }
}
