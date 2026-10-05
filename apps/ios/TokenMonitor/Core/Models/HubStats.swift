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

    func period(_ key: UsagePeriodKey) -> UsagePeriod {
        periods?[key.rawValue] ?? .empty
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
