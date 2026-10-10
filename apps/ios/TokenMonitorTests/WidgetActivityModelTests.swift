import Foundation
import Testing
@testable import TokenMonitor

struct WidgetActivityModelTests {
    private typealias Day = TokenMonitorSharedPayload.Day

    /// Noon on the given local date, in the device time zone.
    private func now(_ key: String) throws -> Date {
        let date = try #require(WidgetActivityModel.localDay(for: key))
        return date.addingTimeInterval(12 * 3_600)
    }

    private func day(_ key: String, _ tokens: Double) -> Day {
        Day(date: key, tokens: tokens, cost: 0)
    }

    // MARK: - Grid

    @Test func gridEndsAtCurrentWeekSundayFirstAndExcludesFuture() throws {
        // 2026-07-31 is a Friday; its week starts Sunday 2026-07-26.
        let reference = try now("2026-07-31")
        let grid = WidgetActivityModel.grid(
            [day("2026-07-31", 10), day("2026-08-02", 20)],
            weekCount: 2,
            now: reference
        )
        #expect(grid.columns.count == 2)
        let calendar = WidgetActivityModel.calendar
        let last = try #require(grid.columns.last)
        #expect(last.cells.count == 7)
        #expect(calendar.component(.weekday, from: last.firstDate) == 1)
        #expect(calendar.isDate(last.firstDate, inSameDayAs: try #require(
            WidgetActivityModel.localDay(for: "2026-07-26"))))
        // Friday is drawn; Saturday after "now" is future and not drawn.
        #expect(last.cells[5].isFuture == false)
        #expect(last.cells[6].isFuture == true)
        // The 2026-08-02 reading is future relative to the reference: excluded.
        let futureDay = try #require(WidgetActivityModel.localDay(for: "2026-08-02"))
        #expect(grid.columns.flatMap(\.cells).allSatisfy { cell in
            !calendar.isDate(cell.date, inSameDayAs: futureDay) || cell.isFuture
        })
        #expect(grid.visibleDays == 7 + 6)
    }

    @Test func missingAndZeroStayDistinct() throws {
        let reference = try now("2026-07-31")
        let grid = WidgetActivityModel.grid(
            [day("2026-07-30", 0), day("2026-07-31", 5)],
            weekCount: 1,
            now: reference
        )
        let cells = grid.columns.last?.cells ?? []
        let zeroCell = cells.first {
            WidgetActivityModel.dayKey(for: $0.date) == "2026-07-30"
        }
        let absentCell = cells.first {
            WidgetActivityModel.dayKey(for: $0.date) == "2026-07-29"
        }
        #expect(zeroCell?.tokens == 0)
        #expect(zeroCell?.level == 0)
        #expect(absentCell?.tokens == nil)
    }

    @Test func quartilesDriveLevels() throws {
        let reference = try now("2026-07-31")
        let days = [
            day("2026-07-26", 100),
            day("2026-07-27", 75),
            day("2026-07-28", 50),
            day("2026-07-29", 25),
            day("2026-07-30", 1)
        ]
        let grid = WidgetActivityModel.grid(days, weekCount: 1, now: reference)
        let levels = Dictionary(
            uniqueKeysWithValues: grid.columns
                .flatMap(\.cells)
                .compactMap { cell in cell.tokens.map { ($0, cell.level) } }
        )
        #expect(levels[100] == 4)
        #expect(levels[75] == 4)
        #expect(levels[50] == 3)
        #expect(levels[25] == 2)
        #expect(levels[1] == 1)
        #expect(grid.peak == 100)
        #expect(grid.activeDays == 5)
    }

    // MARK: - Readings

    @Test func streakCountsThroughYesterdayWhenTodayAbsent() throws {
        let reference = try now("2026-07-31")
        let days = [
            day("2026-07-28", 10),
            day("2026-07-29", 10),
            day("2026-07-30", 10)
        ]
        // Today is absent — the streak counts from yesterday: 3.
        #expect(WidgetActivityModel.streak(days, now: reference) == 3)
    }

    @Test func reportedZeroTodayEndsStreakAtZero() throws {
        let reference = try now("2026-07-31")
        let days = [
            day("2026-07-29", 10),
            day("2026-07-30", 10),
            day("2026-07-31", 0)
        ]
        #expect(WidgetActivityModel.streak(days, now: reference) == 0)
    }

    @Test func gapBreaksStreak() throws {
        let reference = try now("2026-07-31")
        let days = [
            day("2026-07-28", 10),
            day("2026-07-30", 0),
            day("2026-07-31", 10)
        ]
        // Only today counts — yesterday was a reported zero.
        #expect(WidgetActivityModel.streak(days, now: reference) == 1)
    }

    @Test func last7TotalIsNilWithoutAnyPresentDay() throws {
        let reference = try now("2026-07-31")
        #expect(WidgetActivityModel.last7Total([], now: reference) == nil)
        // A day older than the window does not count.
        #expect(WidgetActivityModel.last7Total(
            [day("2026-07-20", 10)], now: reference) == nil)
        #expect(WidgetActivityModel.last7Total(
            [day("2026-07-25", 10), day("2026-07-31", 5)], now: reference) == 15)
    }

    @Test func todayEntryDistinguishesAbsentFromZero() throws {
        let reference = try now("2026-07-31")
        #expect(WidgetActivityModel.today([], now: reference) == nil)
        #expect(WidgetActivityModel.today(
            [day("2026-07-31", 0)], now: reference)?.tokens == 0)
    }

    // MARK: - Bars

    @Test func barSeriesPerPeriod() throws {
        let reference = try now("2026-07-31")
        let days = [day("2026-07-31", 100), day("2026-07-25", 50)]

        let today = WidgetActivityModel.bars(days, period: "today", now: reference)
        #expect(today.count == 7)
        #expect(WidgetActivityModel.dayKey(for: today.last!.date) == "2026-07-31")
        #expect(today.last!.fraction == 1)
        #expect(today.first { WidgetActivityModel.dayKey(for: $0.date) == "2026-07-25" }?.fraction == 0.5)
        // Absent days keep a nil reading, not a zero.
        #expect(today.first { WidgetActivityModel.dayKey(for: $0.date) == "2026-07-26" }?.tokens == nil)

        let month = WidgetActivityModel.bars(days, period: "month", now: reference)
        #expect(month.count == 31)

        let allTime = WidgetActivityModel.bars(days, period: "allTime", now: reference)
        #expect(allTime.count == 30)
    }

    @Test func fixedDayCountSeries() throws {
        let reference = try now("2026-07-31")
        let bars = WidgetActivityModel.bars([], dayCount: 14, now: reference)
        #expect(bars.count == 14)
        #expect(WidgetActivityModel.dayKey(for: bars.last!.date) == "2026-07-31")
        #expect(bars.allSatisfy { $0.tokens == nil && $0.fraction == 0 })
    }

    // MARK: - Live "today" merged into the history

    private func entry(liveTokens: Double, known: Bool?, history: [Day]) -> TokenMonitorWidgetEntry {
        typealias P = TokenMonitorSharedPayload
        let today = P.Usage(
            tokens: liveTokens, cost: 12.3,
            cacheReadTokens: 0, outputTokens: 0,
            tools: [], models: [],
            tokensKnown: known
        )
        let snapshot = P.Snapshot(
            updatedAt: .now,
            today: today,
            month: today,
            allTime: today,
            limits: [],
            activity: history
        )
        return TokenMonitorWidgetEntry(
            date: .now,
            snapshot: snapshot,
            preferences: .default,
            content: "activity",
            period: "today",
            providerID: nil,
            showsCost: false,
            showsUpdateTime: false,
            ink: .recommended
        )
    }

    private func key(_ daysAgo: Int) -> String {
        let date = Calendar.current.date(byAdding: .day, value: -daysAgo, to: .now)!
        return WidgetActivityModel.dayKey(for: date)
    }

    @Test func liveTodayFillsHistoryGap() {
        let entry = entry(liveTokens: 165_200_000, known: nil, history: [
            day(key(1), 40_000_000)
        ])
        let todayKey = key(0)
        let merged = entry.days
        #expect(merged.first { $0.date == todayKey }?.tokens == 165_200_000)
        // Every consumer — bars, grid, Today stat — reads the merged series.
        let bars = WidgetActivityModel.bars(merged, period: "today", now: entry.date)
        #expect(bars.last?.tokens == 165_200_000)
        let grid = WidgetActivityModel.grid(merged, weekCount: 1, now: entry.date)
        #expect(grid.columns.last?.cells.last { !$0.isFuture }?.tokens == 165_200_000)
        #expect(WidgetActivityModel.today(merged, now: entry.date)?.tokens == 165_200_000)
    }

    @Test func liveTodayReplacesStaleHistoryDay() {
        let entry = entry(liveTokens: 165_200_000, known: true, history: [
            day(key(0), 1_000),
            day(key(1), 40_000_000)
        ])
        #expect(entry.days.filter { $0.date == key(0) }.count == 1)
        #expect(entry.days.first { $0.date == key(0) }?.tokens == 165_200_000)
    }

    @Test func unknownLiveTokensLeavesHistoryUntouched() {
        let history = [day(key(1), 40_000_000), day(key(0), 1_000)]
        #expect(
            entry(liveTokens: 165_200_000, known: false, history: history).days == history
        )
    }
}
