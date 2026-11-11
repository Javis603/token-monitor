import Foundation

nonisolated struct HubStreamEvent: Decodable, Sendable {
    let type: String?
    let reason: String?
    let stats: HubStats?
    let at: String?
}
