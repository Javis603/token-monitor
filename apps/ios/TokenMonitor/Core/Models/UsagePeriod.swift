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
