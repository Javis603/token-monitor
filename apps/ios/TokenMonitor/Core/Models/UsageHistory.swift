import Foundation

nonisolated struct UsageHistory: Decodable, Sendable {
    let daily: [HistoryDay]?
    let monthly: [HistoryMonth]?
    let summary: HistorySummary?

    static let empty = UsageHistory(daily: [], monthly: [], summary: nil)

    /// Aggregate calendar buckets without dropping optional price uncertainty.
    static func weeklyBuckets(_ days: [HistoryDay], timeZone: TimeZone = .autoupdatingCurrent) -> [HistoryDay] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        let grouped = Dictionary(grouping: days) { day in
            Date.hubDay(from: day.date, timeZone: timeZone)
                .flatMap { calendar.dateInterval(of: .weekOfYear, for: $0)?.start } ?? .distantPast
        }
        return grouped.compactMap { start, days in
            guard start != .distantPast else { return nil }
            let prices = days.compactMap(\.unpricedTokens)
            return HistoryDay(date: formatter.string(from: start),
                tokens: days.allSatisfy { $0.tokens == nil } ? nil : days.compactMap(\.tokens).reduce(0, +),
                cost: days.allSatisfy { $0.cost == nil } ? nil : days.compactMap(\.cost).reduce(0, +),
                messages: nil, activeTimeMs: nil,
                unpricedTokens: prices.isEmpty ? nil : prices.reduce(0, +))
        }.sorted { ($0.date ?? "") < ($1.date ?? "") }
    }

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
