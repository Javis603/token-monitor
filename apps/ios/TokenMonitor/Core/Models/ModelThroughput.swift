import Foundation

/// Raw matched counters, never a wall-clock estimate or a stored rate.
nonisolated struct ModelThroughput: Decodable, Sendable {
    let timedTokens: Double?
    let timedOutputTokens: Double?
    let timedDurationMs: Double?

    var counters: LiveTokenRateTracker.Counters? {
        guard let timedTokens, let timedOutputTokens, let timedDurationMs else { return nil }
        return .init(tokens: timedTokens, output: timedOutputTokens, duration: timedDurationMs)
    }
}
