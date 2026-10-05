import Foundation

nonisolated struct LimitsSummary: Decodable, Sendable {
    let updatedAt: String?
    let refreshMs: Double?
    let providers: [LimitProvider]?
}
