import Foundation

nonisolated struct PromptCacheObservation: Decodable, Sendable {
    let observedAt: String
    let ttlSeconds: Int
}
