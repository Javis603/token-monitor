import Foundation

/// Only the bounded, authenticated Hub summary is decoded. Transcripts stay on the collector.
nonisolated struct SessionUsage: Decodable, Sendable {
    let client: String?
    let sessionId: String?
    let title: String?
    let projectLabel: String?
    let totalTokens: Double?
    let costUsd: Double?
    let messageCount: Int?
    let outputTokens: Double?
    let timedOutputTokens: Double?
    let timedDurationMs: Double?
    let lastUsedAt: String?
    let startedAt: String?
    let models: [String: Double]?
    let contextTokens: Double?
    let contextWindow: Double?
    let turnEnded: Bool?
    let tokenDataUnavailable: Bool?

    var displayTitle: String? {
        guard let title else { return nil }
        let bounded = title.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return bounded.isEmpty ? nil : String(bounded.prefix(160))
    }

    var lastActivity: Date? {
        Date.hubTimestamp(from: lastUsedAt) ?? Date.hubTimestamp(from: startedAt)
    }

    var primaryModel: String? {
        models?.sorted {
            $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value
        }.first?.key
    }

    var measuredTokens: Double? {
        guard tokenDataUnavailable != true, let totalTokens,
              totalTokens.isFinite, totalTokens >= 0 else { return nil }
        return totalTokens
    }

    var outputTokensPerSecond: Double? {
        guard let timedOutputTokens, let timedDurationMs,
              timedOutputTokens.isFinite, timedDurationMs.isFinite,
              timedOutputTokens > 0, timedDurationMs > 0 else { return nil }
        let speed = timedOutputTokens / (timedDurationMs / 1_000)
        return speed.isFinite ? speed : nil
    }

    func matches(_ query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        return [displayTitle, client, sessionId, projectLabel, primaryModel]
            .compactMap { $0 }
            .contains { $0.localizedStandardContains(query) }
    }
}
