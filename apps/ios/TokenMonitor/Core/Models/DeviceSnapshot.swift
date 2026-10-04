import Foundation

nonisolated struct DeviceSnapshot: Decodable, Identifiable, Sendable {
    let deviceId: String?
    let hostname: String?
    let platform: String?
    let osName: String?
    let osVersion: String?
    let agentVersion: String?
    let updatedAt: String?
    let receivedAt: String?
    let ageMs: Double?
    let stale: Bool?
    let periods: [String: UsagePeriod]?

    var id: String {
        deviceId ?? hostname ?? "unknown-device"
    }

    var displayName: String {
        let candidate = hostname?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let candidate, !candidate.isEmpty {
            return candidate
        }
        return id
    }

    func period(_ key: UsagePeriodKey) -> UsagePeriod {
        periods?[key.rawValue] ?? .unknown
    }
}
