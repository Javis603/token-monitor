import Foundation

nonisolated struct HistoryDay: Decodable, Identifiable, Sendable {
    let date: String?
    let tokens: Double?
    let cost: Double?
    let messages: Double?
    let activeTimeMs: Double?

    var id: String { date ?? "unknown-day" }

    var dateValue: Date? {
        Date.hubDay(from: date)
    }
}
