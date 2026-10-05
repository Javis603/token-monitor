import Foundation

nonisolated struct LimitWindow: Decodable, Identifiable, Sendable {
    let kind: String?
    let metric: String?
    let label: String?
    let used: Double?
    let limit: Double?
    let remaining: Double?
    let usedPercent: Double?
    let remainingPercent: Double?
    let resetsAt: String?
    let resetDescription: String?
    let detail: String?
    let currency: String?
    let showMeter: Bool?

    var id: String {
        [kind, metric, label, resetsAt]
            .compactMap { $0 }
            .joined(separator: ":")
    }

    var isCredits: Bool {
        metric == "credits"
    }

    var effectiveRemainingPercent: Double? {
        if let remainingPercent {
            return min(100, max(0, remainingPercent))
        }
        if let usedPercent {
            return min(100, max(0, 100 - usedPercent))
        }
        return nil
    }
}
