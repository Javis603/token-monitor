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
    var models: [String: Double]?
    let contextTokens: Double?
    let contextWindow: Double?
    let turnEnded: Bool?
    let tokenDataUnavailable: Bool?
    var inputTokens: Double? = nil
    var cacheReadTokens: Double? = nil
    var cacheWriteTokens: Double? = nil
    var archived: Bool? = nil
    var deleted: Bool? = nil
    var sourceDeleted: Bool? = nil
    var sessionKind: String? = nil
    var promptCache: PromptCacheObservation? = nil

    var isBackgroundReview: Bool { sessionKind?.trimmingCharacters(in: .whitespacesAndNewlines) == "background-review" }
    func isRunning(at now: Date) -> Bool { isRecent(at: now) && turnEnded != true }

    func cacheMinutesRemaining(at now: Date) -> Int? {
        guard !isArchived, client == "codex" || client == "claude", let promptCache,
              [300, 1800, 3600].contains(promptCache.ttlSeconds),
              let observed = Date.hubTimestamp(from: promptCache.observedAt), observed <= now else { return nil }
        let remaining = observed.addingTimeInterval(Double(promptCache.ttlSeconds)).timeIntervalSince(now)
        return remaining > 0 ? Int(ceil(remaining / 60)) : nil
    }

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
        let measuredOutput = outputTokens.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        let speed = min(timedOutputTokens, measuredOutput ?? timedOutputTokens) / (timedDurationMs / 1_000)
        return speed.isFinite && speed > 0 ? speed : nil
    }

    var modelEntries: [BreakdownEntry] {
        (models ?? [:]).filter { !$0.key.isEmpty && $0.value.isFinite && $0.value > 0 }
            .map { BreakdownEntry(id: $0.key, value: $0.value, cost: 0) }
            .sorted { $0.value == $1.value ? $0.id < $1.id : $0.value > $1.value }
    }

    var cacheHitPercent: Double? {
        guard measuredTokens != nil,
              let inputTokens, inputTokens.isFinite, inputTokens >= 0,
              let cacheReadTokens, cacheReadTokens.isFinite, cacheReadTokens >= 0,
              let cacheWriteTokens, cacheWriteTokens.isFinite, cacheWriteTokens >= 0,
              cacheReadTokens > 0 || cacheWriteTokens > 0 else { return nil }
        let input = inputTokens + cacheReadTokens + cacheWriteTokens
        guard input.isFinite, input > 0 else { return nil }
        return cacheReadTokens / input * 100
    }

    var isArchived: Bool { archived == true || deleted == true || sourceDeleted == true }

    func isRecent(at now: Date) -> Bool {
        guard !isArchived, let last = Date.hubTimestamp(from: lastUsedAt) else { return false }
        let age = now.timeIntervalSince(last)
        return age >= 0 && age <= 600
    }

    func contextUsedPercent(at now: Date) -> Double? {
        guard isRecent(at: now), let contextTokens, let contextWindow,
              contextTokens.isFinite, contextWindow.isFinite,
              contextTokens > 0, contextWindow > 0 else { return nil }
        let left = max(0, ((contextWindow - contextTokens) / contextWindow * 100).rounded())
        return 100 - left
    }

    func matches(_ query: String) -> Bool {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return true }
        return ([displayTitle, client, sessionId, projectLabel] + modelEntries.map { Optional($0.id) })
            .compactMap { $0 }
            .contains { $0.localizedStandardContains(query) }
    }
}
