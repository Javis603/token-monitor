import Foundation

/// Calendar-day billing metadata from the shared Hub document, not usage costs.
nonisolated struct SharedSubscription: Decodable, Identifiable, Sendable {
    struct Binding: Decodable, Sendable {
        let profileName: String?
        let accountKey: String?
        let accountEmail: String?
    }
    struct TopUp: Decodable, Identifiable, Sendable {
        let id: String
        let date: String
        let amountMinor: Double
    }
    let id: String
    let provider: String
    let kind: String?
    let binding: Binding?
    let planName: String?
    let amountMinor: Double?
    let currency: String
    let interval: String?
    let intervalCount: Int?
    let startDate: String?
    let topUps: [TopUp]?
    let autoRenew: Bool?
    let nextRenewalOverride: String?
    let endDate: String?
    let note: String?

    var isTopUp: Bool { kind == "topup" }
    var months: Int { min(24, max(1, intervalCount ?? 1)) * (interval == "year" ? 12 : 1) }
    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }
    static func validDay(_ day: String?) -> String? {
        guard let day, let date = Date.hubDay(from: day),
              Self.dayString(date, calendar: calendar) == day else { return nil }
        return day
    }
    static func dayString(_ date: Date, calendar: Calendar? = nil) -> String {
        // Billing keys are Gregorian calendar days in the user's current zone.
        // A Buddhist/Japanese system calendar must never change the wire year.
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar?.timeZone ?? .current
        let parts = gregorian.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }
    private func anchoredDate(months offset: Int) -> String? {
        guard let start = Self.validDay(startDate), let date = Date.hubDay(from: start) else { return nil }
        let cal = Self.calendar
        let parts = cal.dateComponents([.year, .month, .day], from: date)
        guard let first = cal.date(from: DateComponents(year: parts.year, month: parts.month, day: 1)),
              let target = cal.date(byAdding: .month, value: offset, to: first),
              let range = cal.range(of: .day, in: .month, for: target),
              let result = cal.date(byAdding: .day, value: min(parts.day ?? 1, range.count) - 1, to: target) else { return nil }
        return Self.dayString(result, calendar: cal)
    }
    var coverageStop: String? {
        if isTopUp { return nil }
        return Self.validDay(endDate) ?? (autoRenew == false ? anchoredDate(months: months) : nil)
    }
    func nextRenewal(today: String) -> String? {
        guard !isTopUp, autoRenew != false, Self.validDay(today) != nil else { return nil }
        let candidate: String?
        if let override = Self.validDay(nextRenewalOverride), override >= today { candidate = override }
        else if let start = Self.validDay(startDate), let anchor = Date.hubDay(from: start),
                let current = Date.hubDay(from: today) {
            let a = Self.calendar.dateComponents([.year, .month], from: anchor)
            let b = Self.calendar.dateComponents([.year, .month], from: current)
            let elapsed = ((b.year ?? 0) - (a.year ?? 0)) * 12 + (b.month ?? 0) - (a.month ?? 0)
            let periods = max(0, elapsed / months)
            let nearby = anchoredDate(months: periods * months)
            candidate = nearby.flatMap { $0 < today ? anchoredDate(months: (periods + 1) * months) : $0 }
        } else { candidate = nil }
        guard let candidate, coverageStop.map({ candidate < $0 }) ?? true else { return nil }
        return candidate
    }
    func monthlyAmountUSD(today: String) -> Double? {
        if let stop = coverageStop, stop <= today { return 0 }
        guard let currency = AppCurrency(rawValue: currency) else { return nil }
        let amount: Double
        if isTopUp {
            guard (topUps ?? []).allSatisfy({
                Self.validDay($0.date) != nil && $0.amountMinor.isFinite && $0.amountMinor >= 0
            }) else { return nil }
            amount = (topUps ?? []).filter {
                Self.validDay($0.date) != nil && $0.date.prefix(7) == today.prefix(7)
            }.reduce(0) { $0 + $1.amountMinor }
        } else {
            guard let amountMinor else { return nil }
            amount = amountMinor / Double(months)
        }
        guard amount.isFinite, amount >= 0 else { return nil }
        return amount / 100 / currency.rateFromUSD
    }
}
