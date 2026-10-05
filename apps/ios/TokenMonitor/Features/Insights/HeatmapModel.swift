import Foundation

struct HeatmapModel: Equatable {
    struct Cell: Equatable, Identifiable {
        let date: Date
        let tokens: Double
        let cost: Double
        let intensity: Int

        var id: Date { date }
    }

    struct Week: Equatable, Identifiable {
        let index: Int
        let cells: [Cell]

        var id: Int { index }
    }

    let weeks: [Week]
    let activeDays: Int
    let peakValue: Double

    static func make(
        days: [HistoryDay],
        metric: TrendMetric,
        weekCount: Int = 52,
        referenceDate: Date = .now
    ) -> HeatmapModel {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 1
        calendar.timeZone = .current

        let endDate = calendar.startOfDay(for: referenceDate)
        let weekStart = calendar.dateInterval(
            of: .weekOfYear,
            for: endDate
        )?.start ?? endDate
        let firstWeekStart = calendar.date(
            byAdding: .day,
            value: -7 * max(0, weekCount - 1),
            to: weekStart
        ) ?? weekStart

        let valuesByDate = Dictionary(
            uniqueKeysWithValues: days.compactMap { day -> (Date, HistoryDay)? in
                guard let date = day.dateValue else {
                    return nil
                }
                return (calendar.startOfDay(for: date), day)
            }
        )
        let peak = max(
            0,
            valuesByDate.values.map { value(for: $0, metric: metric) }.max() ?? 0
        )

        let weeks = (0..<max(1, weekCount)).map { weekIndex in
            let cells = (0..<7).map { dayIndex in
                let offset = weekIndex * 7 + dayIndex
                let date = calendar.date(
                    byAdding: .day,
                    value: offset,
                    to: firstWeekStart
                ) ?? firstWeekStart
                let day = valuesByDate[date]
                let tokens = day?.tokens ?? 0
                let cost = day?.cost ?? 0
                let value = metric == .tokens ? tokens : cost
                return Cell(
                    date: date,
                    tokens: tokens,
                    cost: cost,
                    intensity: intensity(for: value, maximum: peak)
                )
            }
            return Week(index: weekIndex, cells: cells)
        }

        return HeatmapModel(
            weeks: weeks,
            activeDays: valuesByDate.values.count {
                ($0.tokens ?? 0) > 0 || ($0.cost ?? 0) > 0
            },
            peakValue: peak
        )
    }

    private static func value(
        for day: HistoryDay,
        metric: TrendMetric
    ) -> Double {
        metric == .tokens ? day.tokens ?? 0 : day.cost ?? 0
    }

    private static func intensity(for value: Double, maximum: Double) -> Int {
        guard maximum > 0, value > 0 else {
            return 0
        }
        let ratio = value / maximum
        if ratio >= 0.75 {
            return 4
        }
        if ratio >= 0.5 {
            return 3
        }
        if ratio >= 0.25 {
            return 2
        }
        return 1
    }
}
