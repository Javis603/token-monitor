import Foundation

nonisolated struct UsageHistory: Decodable, Sendable {
    let daily: [HistoryDay]?
    let monthly: [HistoryMonth]?
    let summary: HistorySummary?

    static let empty = UsageHistory(daily: [], monthly: [], summary: nil)
}
