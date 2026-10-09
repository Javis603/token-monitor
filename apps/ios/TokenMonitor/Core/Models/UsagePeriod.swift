import Foundation

nonisolated struct UsagePeriod: Decodable, Sendable {
    let totalTokens: Double?
    let costUsd: Double?
    let cacheReadTokens: Double?
    let cacheWriteTokens: Double?
    let outputTokens: Double?
    let clients: [String: Double]?
    let clientCosts: [String: Double]?
    var models: [String: Double]?
    var modelCosts: [String: Double]?
    var sessions: [String: SessionUsage]? = nil
    var sessionDetailsOmitted: Int? = nil
    var capabilities: Capabilities? = nil
    var unclassifiedTokens: Double? = nil
    var timedTokens: Double? = nil
    var timedOutputTokens: Double? = nil
    var timedDurationMs: Double? = nil

    struct Capabilities: Decodable, Sendable {
        let tokenComponents: Bool?
        let throughput: Bool?
    }

    // Missing periods carry unknown counters. A wire-level zero remains zero.
    static let unknown = UsagePeriod(totalTokens: nil, costUsd: nil,
        cacheReadTokens: nil, cacheWriteTokens: nil, outputTokens: nil,
        clients: nil, clientCosts: nil, models: nil, modelCosts: nil)

    static let empty = UsagePeriod(
        totalTokens: 0,
        costUsd: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        clients: [:],
        clientCosts: [:],
        models: [:],
        modelCosts: [:]
    )

    /// The desktop input breakdown excludes output and unclassified tokens.
    var cacheHitPercent: Double? {
        guard let totalTokens, totalTokens.isFinite, totalTokens >= 0,
              let cacheReadTokens, cacheReadTokens.isFinite, cacheReadTokens >= 0,
              let outputTokens, outputTokens.isFinite, outputTokens >= 0 else { return nil }
        let unknown = unclassifiedTokens ?? 0
        guard unknown.isFinite, unknown >= 0 else { return nil }
        // An explicit unknown portion permits a rate for the classified input.
        // A false capability without that breakdown still cannot prove a rate.
        guard capabilities?.tokenComponents != false || unknown > 0 else { return nil }
        let classified = totalTokens - min(totalTokens, unknown)
        let read = min(classified, cacheReadTokens)
        let output = min(classified - read, outputTokens)
        let input = classified - output
        guard input > 0 else { return nil }
        return read / input * 100
    }

    var cacheHitUsesPartialData: Bool {
        cacheHitPercent != nil && (unclassifiedTokens ?? 0) > 0
    }

    /// Only output that has its own reported duration contributes to this average.
    var averageOutputTokensPerSecond: Double? {
        guard capabilities?.throughput != false,
              let timedOutputTokens, timedOutputTokens.isFinite, timedOutputTokens > 0,
              let timedDurationMs, timedDurationMs.isFinite, timedDurationMs > 0 else { return nil }
        let output = outputTokens.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
        let speed = min(timedOutputTokens, output ?? timedOutputTokens) / (timedDurationMs / 1_000)
        return speed.isFinite && speed > 0 ? speed : nil
    }

    var clientEntries: [BreakdownEntry] {
        (clients ?? [:])
            .map { key, value in
                BreakdownEntry(id: key, value: value, cost: clientCosts?[key] ?? 0)
            }
            .sorted { lhs, rhs in
                lhs.value == rhs.value ? lhs.id < rhs.id : lhs.value > rhs.value
            }
    }

    var modelEntries: [BreakdownEntry] {
        (models ?? [:])
            .map { key, value in
                BreakdownEntry(id: key, value: value, cost: modelCosts?[key] ?? 0)
            }
            .sorted { lhs, rhs in
                lhs.value == rhs.value ? lhs.id < rhs.id : lhs.value > rhs.value
            }
    }
}
