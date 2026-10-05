import Foundation

nonisolated struct UsagePeriod: Decodable, Sendable {
    let totalTokens: Double?
    let costUsd: Double?
    let cacheReadTokens: Double?
    let cacheWriteTokens: Double?
    let outputTokens: Double?
    let clients: [String: Double]?
    let clientCosts: [String: Double]?
    let models: [String: Double]?
    let modelCosts: [String: Double]?

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
