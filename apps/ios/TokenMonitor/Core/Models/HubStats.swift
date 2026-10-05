import Foundation

nonisolated struct HubStats: Decodable, Sendable {
    let updatedAt: String?
    let periods: [String: UsagePeriod]?
    let devices: [DeviceSnapshot]?
    let limits: LimitsSummary?
    let historyPreview: UsageHistory?
    let historyRevision: String?
    let staleAfterMs: Double?
    let projectsIncomplete: Bool?

    func sourceUpdatedAt(now: Date = .now) -> Date? {
        let sources = devices ?? []
        if !sources.isEmpty {
            return sources.compactMap { Date.hubTimestamp(from: $0.updatedAt) }
                .filter { $0 <= now }.max()
        }
        guard let date = Date.hubTimestamp(from: updatedAt), date <= now else { return nil }
        return date
    }

    var allSourcesStale: Bool? {
        guard let devices, !devices.isEmpty else { return nil }
        if devices.contains(where: { $0.stale == false }) { return false }
        return devices.allSatisfy { $0.stale == true } ? true : nil
    }

    func period(_ key: UsagePeriodKey) -> UsagePeriod {
        periods?[key.rawValue] ?? .unknown
    }

    var sortedDevices: [DeviceSnapshot] {
        (devices ?? []).sorted { lhs, rhs in
            let lhsStale = lhs.stale == true
            let rhsStale = rhs.stale == true
            if lhsStale != rhsStale {
                return !lhsStale
            }
            return lhs.displayName.localizedStandardCompare(rhs.displayName) == .orderedAscending
        }
    }

    /// Display order for every limits surface: the user's order over the
    /// desktop catalog default, minus hidden providers.
    func orderedLimits(
        order: [String],
        hidden: Set<String> = []
    ) -> [LimitProvider] {
        LimitProviderOrder.ordered(
            limits?.providers ?? [],
            order: order,
            hidden: hidden
        )
    }

    /// Lowest-remaining-first; kept only for the "Auto — most constrained"
    /// Live Activity/widget selection.
    var sortedLimits: [LimitProvider] {
        (limits?.providers ?? []).sorted { lhs, rhs in
            switch (lhs.lowestRemainingPercent, rhs.lowestRemainingPercent) {
            case let (left?, right?) where left != right:
                return left < right
            case (_?, nil):
                return true
            case (nil, _?):
                return false
            default:
                return lhs.accountTitle.localizedStandardCompare(rhs.accountTitle) == .orderedAscending
            }
        }
    }
}
