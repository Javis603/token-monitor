import Foundation

extension UsageHistory {
    static var sample: UsageHistory {
        let calendar = Calendar(identifier: .gregorian)
        let start = calendar.date(byAdding: .day, value: -29, to: .now) ?? .now
        let daily = (0..<30).map { offset in
            let date = calendar.date(byAdding: .day, value: offset, to: start) ?? start
            let wave = Double((offset * 37) % 11) / 10
            return HistoryDay(
                date: date.formatted(.iso8601.year().month().day()),
                tokens: 6_000_000 + Double(offset) * 240_000 + wave * 7_800_000,
                cost: 5 + Double(offset) * 0.23 + wave * 4.8,
                messages: 120 + Double(offset * 4),
                activeTimeMs: 4_000_000 + wave * 2_000_000
            )
        }
        let monthly = (0..<6).map { offset in
            let date = calendar.date(byAdding: .month, value: -offset, to: .now) ?? .now
            let scale = Double(6 - offset)
            return HistoryMonth(
                month: date.formatted(.iso8601.year().month()),
                tokens: 240_000_000 + scale * 73_000_000,
                cost: 190 + scale * 58,
                activeTimeMs: 155_000_000 + scale * 21_000_000
            )
        }
        return UsageHistory(
            daily: daily,
            monthly: monthly,
            summary: HistorySummary(
                totalTokens: 5_837_996_083,
                totalCost: 5_025.25,
                activeDays: 111,
                currentStreak: 18,
                longestStreak: 42,
                peakDayTokens: 278_400_000,
                favoriteModel: "gpt-5.5",
                messages: 53_000,
                activeTimeMs: 1_953_600_000
            )
        )
    }
}
