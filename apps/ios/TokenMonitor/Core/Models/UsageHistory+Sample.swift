import Foundation

extension UsageHistory {
    static var sample: UsageHistory {
        let calendar = Calendar(identifier: .gregorian)
        let dayFormatter = DateFormatter()
        dayFormatter.calendar = calendar
        dayFormatter.locale = Locale(identifier: "en_US_POSIX")
        dayFormatter.timeZone = calendar.timeZone
        dayFormatter.dateFormat = "yyyy-MM-dd"
        let today = calendar.startOfDay(for: .now)
        let start = calendar.date(byAdding: .day, value: -209, to: today) ?? today
        let daily = (0..<210).map { offset in
            let date = calendar.date(byAdding: .day, value: offset, to: start) ?? start
            // Illustrative history includes quiet days, clustered work and occasional peaks.
            let phase = Double(offset)
            let baseline = 12 + 5 * sin(phase * 0.24) + 3 * cos(phase * 0.73)
            let burst = 55 * exp(-pow((Double(offset % 47) - 29) / 4, 2))
                + 28 * exp(-pow((Double(offset % 31) - 17) / 2.2, 2))
            let variation = Double((offset * 13) % 9) - 4
            let tokens = offset % 19 == 0 ? 0 : max(0, baseline + burst + variation) * 1_000_000
            return HistoryDay(
                date: dayFormatter.string(from: date),
                tokens: tokens,
                cost: tokens / 1_000_000 * (0.75 + Double(offset % 5) * 0.03),
                messages: 120 + Double(offset * 4),
                activeTimeMs: tokens / 1_000_000 * 240_000
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
                activeDays: Double(daily.count { ($0.tokens ?? 0) > 0 }),
                currentStreak: 18,
                longestStreak: 42,
                peakDayTokens: daily.compactMap(\.tokens).max(),
                favoriteModel: "gpt-5.5",
                messages: 53_000,
                activeTimeMs: 1_953_600_000
            )
        )
    }
}
