import Foundation

/// Pure activity math for the Home Screen widgets: GitHub-style week grid,
/// trailing daily bars, today / last-7 / streak readings. Day keys are
/// calendar dates (`yyyy-MM-dd`) resolved on a Gregorian calendar in the
/// device time zone — never UTC instants on the user's clock.
nonisolated enum WidgetActivityModel {
    typealias Day = TokenMonitorSharedPayload.Day

    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 1 // Sunday-first, like Insights' heatmap.
        calendar.timeZone = .current
        return calendar
    }

    /// Local start-of-day for a `yyyy-MM-dd` key, or nil when it cannot parse.
    static func localDay(for key: String) -> Date? {
        let parts = key.split(separator: "-")
        guard parts.count == 3,
              let year = Int(parts[0]),
              let month = Int(parts[1]),
              let day = Int(parts[2]) else { return nil }
        return calendar.date(from: DateComponents(year: year, month: month, day: day))
    }

    static func dayKey(for date: Date) -> String {
        let components = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d",
                      components.year ?? 0, components.month ?? 0, components.day ?? 0)
    }

    /// Present (reported) days keyed by local start-of-day. Entries without a
    /// parseable date or a finite non-negative reading are absent, not zero.
    static func daysByDate(_ days: [Day]) -> [Date: Day] {
        var result: [Date: Day] = [:]
        for day in days {
            guard let date = localDay(for: day.date),
                  day.tokens.isFinite, day.tokens >= 0 else { continue }
            result[date] = day
        }
        return result
    }

    /// Today's reported entry, or nil when today is absent.
    static func today(_ days: [Day], now: Date) -> Day? {
        daysByDate(days)[calendar.startOfDay(for: now)]
    }

    /// Sum over reported days in the last 7 calendar days; nil when none are
    /// present at all.
    static func last7Total(_ days: [Day], now: Date) -> Double? {
        let calendar = calendar
        let end = calendar.startOfDay(for: now)
        guard let start = calendar.date(byAdding: .day, value: -6, to: end) else { return nil }
        let values = daysByDate(days)
            .filter { $0.key >= start && $0.key <= end }
            .map(\.value.tokens)
        return values.isEmpty ? nil : values.reduce(0, +)
    }

    /// Consecutive days with tokens > 0 ending today — or ending yesterday
    /// when today is absent. A reported zero today ends the streak at 0.
    static func streak(_ days: [Day], now: Date) -> Int {
        let calendar = calendar
        let values = daysByDate(days)
        var cursor = calendar.startOfDay(for: now)
        if values[cursor] == nil {
            guard let yesterday = calendar.date(byAdding: .day, value: -1, to: cursor) else { return 0 }
            cursor = yesterday
        }
        var count = 0
        while let day = values[cursor], day.tokens > 0 {
            count += 1
            guard let previous = calendar.date(byAdding: .day, value: -1, to: cursor) else { break }
            cursor = previous
        }
        return count
    }

    // MARK: - Daily bars

    struct Bar: Equatable, Identifiable {
        /// Local start-of-day this bar covers.
        let date: Date
        /// Reported reading, or nil for an absent day. Zero stays a reading.
        let tokens: Double?
        /// Height fraction within the series maximum (0 for absent/zero).
        let fraction: Double

        var id: Date { date }
    }

    /// The period's bar series: Today → last 7 calendar days, This Month →
    /// month-to-date, All Time → last 30 days.
    static func bars(_ days: [Day], period: String, now: Date) -> [Bar] {
        let calendar = calendar
        let end = calendar.startOfDay(for: now)
        let count: Int
        switch period {
        case "month":
            guard let monthStart = calendar.dateInterval(of: .month, for: end)?.start,
                  let span = calendar.dateComponents([.day], from: monthStart, to: end).day else {
                return []
            }
            count = span + 1
        case "allTime":
            count = 30
        default:
            count = 7
        }
        return bars(days, dayCount: count, now: now)
    }

    /// A fixed trailing series of `dayCount` calendar days ending today.
    static func bars(_ days: [Day], dayCount: Int, now: Date) -> [Bar] {
        let calendar = calendar
        let end = calendar.startOfDay(for: now)
        let values = daysByDate(days)
        let start = calendar.date(byAdding: .day, value: -(dayCount - 1), to: end) ?? end
        var series: [(date: Date, tokens: Double?)] = []
        series.reserveCapacity(dayCount)
        for index in 0..<max(0, dayCount) {
            guard let date = calendar.date(byAdding: .day, value: index, to: start) else { continue }
            series.append((date, values[date]?.tokens))
        }
        let maximum = series.compactMap(\.tokens).filter { $0 > 0 }.max() ?? 0
        return series.map { date, tokens in
            Bar(
                date: date,
                tokens: tokens,
                fraction: maximum > 0 ? min(1, (tokens ?? 0) / maximum) : 0
            )
        }
    }

    // MARK: - Activity grid

    /// One grid cell. `tokens == nil` is an absent day, distinct from a
    /// measured zero; `level` is the Desktop 1–4 intensity for readings > 0.
    struct Cell: Equatable {
        let date: Date
        let tokens: Double?
        let level: Int
        let isFuture: Bool
    }

    /// One week column, Sunday at index 0.
    struct Column: Equatable {
        let cells: [Cell]
        /// The column's Sunday — month labels key off it.
        var firstDate: Date { cells.first?.date ?? .distantPast }
    }

    struct Grid: Equatable {
        /// Week columns, oldest first; the last column is the current week.
        let columns: [Column]
        /// Reported days with tokens > 0 inside the visible window.
        let activeDays: Int
        /// Non-future days inside the visible window.
        let visibleDays: Int
        /// Largest reported reading inside the visible window (0 when none).
        let peak: Double
    }

    /// `weekCount` week columns ending at the current week. Future cells are
    /// marked, not drawn.
    static func grid(_ days: [Day], weekCount: Int, now: Date) -> Grid {
        let calendar = calendar
        let end = calendar.startOfDay(for: now)
        let count = max(1, weekCount)
        let weekStart = calendar.dateInterval(of: .weekOfYear, for: end)?.start ?? end
        let firstStart = calendar.date(byAdding: .day, value: -7 * (count - 1), to: weekStart) ?? weekStart
        let values = daysByDate(days)
            .filter { $0.key >= firstStart && $0.key <= end }
        // Match Desktop's four bands against the full available history.
        // Resizing the widget must not change the colour of the same day.
        let peak = daysByDate(days).filter { $0.key <= end }.values.map(\.tokens).max() ?? 0
        let columns = (0..<count).map { week -> Column in
            Column(cells: (0..<7).map { weekday in
                let date = calendar.date(byAdding: .day, value: week * 7 + weekday, to: firstStart) ?? firstStart
                let tokens = values[date]?.tokens
                return Cell(
                    date: date,
                    tokens: tokens,
                    level: desktopIntensity(for: tokens ?? 0, peak: peak),
                    isFuture: date > end
                )
            })
        }
        return Grid(
            columns: columns,
            activeDays: values.values.count { $0.tokens > 0 },
            visibleDays: columns.flatMap(\.cells).count { !$0.isFuture },
            peak: values.values.map(\.tokens).max() ?? 0
        )
    }

    /// Compact square cells, bounded by BOTH axes; no minimum height may
    /// force a seven-row chart outside a small widget's proposed rectangle.
    static func gridGeometry(width: Double, height: Double, gap: Double = 2, cellCap: Double = 10)
        -> (cell: Double, weeks: Int) {
        guard width.isFinite, height.isFinite, width > 0, height > 6 * gap else {
            return (0, 0)
        }
        let cell = max(0, min(width, (height - 6 * gap) / 7, cellCap))
        let weeks = min(52, max(1, Int(floor((width + gap) / (cell + gap)))))
        return (cell, weeks)
    }

    static func desktopIntensity(for value: Double, peak: Double) -> Int {
        guard value.isFinite, peak.isFinite, value > 0, peak > 0 else { return 0 }
        let ratio = value / peak
        return ratio >= 0.75 ? 4 : ratio >= 0.5 ? 3 : ratio >= 0.25 ? 2 : 1
    }

}
