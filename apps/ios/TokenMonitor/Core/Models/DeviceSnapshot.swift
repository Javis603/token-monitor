import Foundation

nonisolated struct DeviceSnapshot: Decodable, Identifiable, Sendable {
    let deviceId: String?
    var name: String? = nil
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
        if let candidate = [name, hostname].compactMap({ $0?.trimmingCharacters(in: .whitespacesAndNewlines) })
            .first(where: { !$0.isEmpty }) {
            return candidate
        }
        return id
    }

    enum CodingKeys: String, CodingKey {
        case deviceId, hostname, platform, osName, osVersion, agentVersion
        case updatedAt, receivedAt, ageMs, stale, periods
        case name = "displayName"
    }

    func period(_ key: UsagePeriodKey) -> UsagePeriod {
        periods?[key.rawValue] ?? .unknown
    }
}
