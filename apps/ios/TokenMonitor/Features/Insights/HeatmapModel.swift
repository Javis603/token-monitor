import Foundation

struct HeatmapModel: Equatable {
    struct Cell: Equatable, Identifiable {
        let date: Date
        let tokens: Double
        let cost: Double
        let intensity: Int
        let isFuture: Bool
        /// True when the Hub reported the day (even as zero); false = unknown.
        let hasData: Bool

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

    /// Weekday rows are Sunday-first (`firstWeekday = 1`), so today may sit
    /// mid-row in the last column.
    var lastDayDate: Date? {
        weeks.last?.cells.last?.date
    }

    func cell(on date: Date) -> Cell? {
        weeks.flatMap(\.cells).first {
            Calendar.current.isDate($0.date, inSameDayAs: date)
        }
    }

    func cell(atColumn column: Int, row: Int) -> Cell? {
        guard weeks.indices.contains(column) else { return nil }
        let cells = weeks[column].cells
        guard cells.indices.contains(row) else { return nil }
        return cells[row]
    }

    /// How many week columns fill `width` with ~`idealCell`-pt cells so the
    /// grid is flush to both edges.
    static func columnCount(
        forWidth width: Double,
        idealCell: Double = 14,
        gap: Double = 3,
        maxWeeks: Int = 53
    ) -> Int {
        guard width.isFinite, width > 0 else { return 1 }
        let count = Int(((width + gap) / (idealCell + gap)).rounded(.toNearestOrAwayFromZero))
        return min(maxWeeks, max(1, count))
    }

    static func cellSize(forWidth width: Double, columns: Int, gap: Double = 3) -> Double {
        let count = max(1, columns)
        return max(1, (width - gap * Double(count - 1)) / Double(count))
    }

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
            days.compactMap { day -> (Date, HistoryDay)? in
                guard let date = day.dateValue else { return nil }
                // Hub day keys are calendar dates, not UTC instants on the user's clock.
                var sourceCalendar = Calendar(identifier: .gregorian)
                sourceCalendar.timeZone = TimeZone(secondsFromGMT: 0)!
                let components = sourceCalendar.dateComponents([.year, .month, .day], from: date)
                guard let localDate = calendar.date(from: components),
                      localDate <= endDate, localDate >= firstWeekStart else {
                    return nil
                }
                return (localDate, day)
            }, uniquingKeysWith: { _, latest in latest }
        )
        let readings = valuesByDate.values.map { value(for: $0, metric: metric) }
            .filter { $0.isFinite && $0 >= 0 }
        let peak = readings.max() ?? .nan
        // Quartiles over the days that actually had usage, desktop-style ramp.
        let thresholds = quartiles(of: readings.filter { $0 > 0 })

        let weeks = (0..<max(1, weekCount)).map { weekIndex in
            let cells = (0..<7).map { dayIndex in
                let offset = weekIndex * 7 + dayIndex
                let date = calendar.date(
                    byAdding: .day,
                    value: offset,
                    to: firstWeekStart
                ) ?? firstWeekStart
                let day = valuesByDate[date]
                let tokens = day?.tokens ?? .nan
                let cost = day?.cost ?? .nan
                let value = metric == .tokens ? tokens : cost
                return Cell(
                    date: date,
                    tokens: tokens,
                    cost: cost,
                    intensity: intensity(for: value, thresholds: thresholds),
                    isFuture: date > endDate,
                    hasData: day != nil
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

    /// First-quartile / median / third-quartile of sorted positive values —
    /// the boundaries between the four heat levels.
    private static func quartiles(of values: [Double]) -> (Double, Double, Double)? {
        guard !values.isEmpty else { return nil }
        let sorted = values.sorted()
        func quantile(_ p: Double) -> Double {
            sorted[Int((Double(sorted.count - 1) * p).rounded())]
        }
        return (quantile(0.25), quantile(0.5), quantile(0.75))
    }

    private static func intensity(
        for value: Double,
        thresholds: (Double, Double, Double)?
    ) -> Int {
        guard let thresholds, value > 0, value.isFinite else {
            return 0
        }
        if value >= thresholds.2 {
            return 4
        }
        if value >= thresholds.1 {
            return 3
        }
        if value >= thresholds.0 {
            return 2
        }
        return 1
    }

    private static func value(
        for day: HistoryDay,
        metric: TrendMetric
    ) -> Double {
        metric == .tokens ? day.tokens ?? .nan : day.cost ?? .nan
    }
}
