import Foundation

nonisolated struct HistoryDay: Decodable, Identifiable, Sendable {
    let date: String?
    let tokens: Double?
    let cost: Double?
    let messages: Double?
    let activeTimeMs: Double?
    var unpricedTokens: Double? = nil

    var id: String { date ?? "unknown-day" }

    var localDateValue: Date? {
        Date.hubDay(from: date, timeZone: .autoupdatingCurrent)
    }

    var dateValue: Date? {
        Date.hubDay(from: date)
    }
}
