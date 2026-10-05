import Foundation

nonisolated struct HistoryMonth: Decodable, Identifiable, Sendable {
    let month: String?
    let tokens: Double?
    let cost: Double?
    let activeTimeMs: Double?

    var id: String { month ?? "unknown-month" }

    var dateValue: Date? {
        Date.hubMonth(from: month)
    }
}
