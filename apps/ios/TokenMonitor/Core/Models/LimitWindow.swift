import Foundation

nonisolated struct LimitWindow: Decodable, Identifiable, Sendable {
    let kind: String?
    let metric: String?
    var label: String?
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
    var limitId: String? = nil
    var additional: Bool? = nil
    var windowMinutes: Double? = nil

    func displayLabel(providerID: String?) -> String {
        let explicit = label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !explicit.isEmpty { return explicit }
        switch kind?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "session":
            let fiveHour = ["alibaba", "antigravity", "cline", "commandcode", "kimi", "volcengine", "zai", "zaiteam"]
            return fiveHour.contains(providerID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "") ? "5-hour" : "Session"
        case "daily": return "Daily"
        case "weekly": return "Weekly"
        case "billing": return "Monthly"
        default: return "Quota"
        }
    }

    var id: String {
        [limitId, kind, metric, label, additional.map(String.init), windowMinutes.map { String($0) }]
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
