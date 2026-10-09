import Foundation

nonisolated struct UsageHistory: Decodable, Sendable {
    let daily: [HistoryDay]?
    let monthly: [HistoryMonth]?
    let summary: HistorySummary?

    static let empty = UsageHistory(daily: [], monthly: [], summary: nil)

    /// History supplies user-message totals; session calls may be bounded or omitted.
    func messageCount(
        for period: UsagePeriodKey,
        now: Date = .now,
        timeZone: TimeZone = .autoupdatingCurrent
    ) -> Double? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let components = calendar.dateComponents([.year, .month, .day], from: now)
        guard let year = components.year, let month = components.month, let day = components.day else { return nil }
        let monthKey = String(format: "%04d-%02d", year, month)
        let value: Double?
        switch period {
        case .today:
            let dayKey = monthKey + String(format: "-%02d", day)
            value = daily?.first { $0.date == dayKey }?.messages
        case .month:
            value = monthly?.first { $0.month == monthKey }?.messageCount
        case .allTime:
            value = summary?.messages
        }
        guard let value, value.isFinite, value >= 0 else { return nil }
        return value
    }
}
