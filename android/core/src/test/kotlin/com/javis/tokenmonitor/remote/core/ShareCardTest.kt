package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class ShareCardTest {
    @Test
    fun emptyUsageProducesNoCards() {
        assertTrue(shareCards(StatsSnapshot(), PeriodId.Today).isEmpty())
    }

    @Test
    fun zeroTokenRowsAreDroppedAndMissingKindsStayHidden() {
        val snapshot = StatsSnapshot(
            today = PeriodSummary(
                totalTokens = 100,
                costUsd = 1.5,
                clients = listOf(ClientUsage("cursor", 0, 0.0), ClientUsage("codex", 80, 1.0)),
                models = emptyList()
            )
        )
        val cards = shareCards(snapshot, PeriodId.Today)
        assertEquals(listOf(ShareCard.Tokens::class, ShareCard.Cost::class, ShareCard.Tools::class), cards.map { it::class })
        val tools = cards.filterIsInstance<ShareCard.Tools>().single()
        assertEquals(listOf("codex"), tools.rows.map { it.id })
        assertEquals(0.8f, tools.rows.single().fraction, 0.001f)
    }

    @Test
    fun ranksKeepTheThreeLargest() {
        val models = (1..5).map { ClientUsage("m$it", it * 10L, 0.0) }
        val snapshot = StatsSnapshot(today = PeriodSummary(totalTokens = 150, models = models))
        val rows = shareCards(snapshot, PeriodId.Today).filterIsInstance<ShareCard.Models>().single().rows
        assertEquals(listOf("m5", "m4", "m3"), rows.map { it.id })
    }

    @Test
    fun todayShowsEachDayOfTheMonth() {
        val daily = (1..20).map { DayUsage("2026-10-${it.toString().padStart(2, '0')}", it * 1_000L, 0.0) }
        val snapshot = StatsSnapshot(today = PeriodSummary(totalTokens = 1), daily = daily)
        val cards = shareCards(snapshot, PeriodId.Today, LocalDate.of(2026, 10, 20))
        val tokens = cards.filterIsInstance<ShareCard.Tokens>().single()
        assertEquals(20, tokens.bars.size)
        assertEquals("10/1", tokens.bars.first().label)
        assertEquals("10/20", tokens.bars.last().label)
        assertEquals(20_000L, tokens.bars.maxOf { it.tokens })
        val trend = cards.filterIsInstance<ShareCard.Trend>().single()
        val heat = trend.heat!!
        assertTrue(trend.bars.isEmpty())
        assertEquals("2026-09-27", heat.cells.first().date)
        assertEquals("2026-10-20", heat.cells.last().date)
        assertEquals(ShareMark.Today, heat.cells.single { it.date == "2026-10-20" }.mark)
        assertEquals(ShareMark.None, heat.cells.single { it.date == "2026-10-01" }.mark)
        assertEquals("10/1 – 10/20 · 210K", trend.caption)
    }

    @Test
    fun monthShowsWeeks() {
        val daily = (1..20).map { DayUsage("2026-10-${it.toString().padStart(2, '0')}", it * 1_000L, 0.0) }
        val snapshot = StatsSnapshot(month = PeriodSummary(totalTokens = 1), daily = daily)
        val cards = shareCards(snapshot, PeriodId.Month, LocalDate.of(2026, 10, 20))
        val tokens = cards.filterIsInstance<ShareCard.Tokens>().single()
        assertEquals(listOf("10/1–10/4", "10/5–10/11", "10/12–10/18", "10/19–10/20"), tokens.bars.map { it.label })
        assertEquals(listOf(10_000L, 56_000L, 105_000L, 39_000L), tokens.bars.map { it.tokens })
        assertEquals(105_000L, tokens.bars.maxOf { it.tokens })
        assertEquals("10/1", tokens.axisStart)
        assertEquals("10/20", tokens.axisEnd)
        val heat = cards.filterIsInstance<ShareCard.Trend>().single().heat!!
        assertEquals(ShareMark.Month, heat.cells.single { it.date == "2026-10-01" }.mark)
        assertEquals(ShareMark.Today, heat.cells.single { it.date == "2026-10-20" }.mark)
        assertEquals(ShareMark.None, heat.cells.single { it.date == "2026-09-27" }.mark)
    }

    @Test
    fun allTimeUsesAFixedYearHeatmap() {
        val today = LocalDate.of(2026, 10, 31)
        val snapshot = StatsSnapshot(
            allTime = PeriodSummary(totalTokens = 1),
            daily = listOf(
                DayUsage("2026-09-15", 50, 0.0),
                DayUsage("2026-10-01", 100, 0.0),
                DayUsage("2026-10-31", 400, 0.0)
            )
        )
        val cards = shareCards(snapshot, PeriodId.AllTime, today)
        val tokens = cards.filterIsInstance<ShareCard.Tokens>().single()
        assertEquals(listOf("2026/9", "2026/10"), tokens.bars.map { it.label })
        assertEquals("2026/9", tokens.axisStart)
        assertEquals("2026/10", tokens.axisEnd)
        val trend = cards.filterIsInstance<ShareCard.Trend>().single()
        val heat = trend.heat!!
        assertTrue(trend.bars.isEmpty())
        assertTrue(heat.cells.none { it.date == "2025-11-01" })
        assertEquals("2026-09-13", heat.cells.first().date)
        assertEquals("2026-10-31", heat.cells.last().date)
        assertEquals(ShareMark.Today, heat.cells.last().mark)
        assertEquals(ShareMark.Month, heat.cells.single { it.date == "2026-10-01" }.mark)
        assertEquals(ShareMark.None, heat.cells.single { it.date == "2026-09-15" }.mark)
        assertEquals(4, heat.cells.single { it.date == "2026-10-31" }.level)
        assertEquals(2, heat.cells.single { it.date == "2026-10-01" }.level)
        assertEquals(1, heat.cells.single { it.date == "2026-09-15" }.level)
        assertEquals(listOf("2026/9", "10月"), heat.months.map { it.label })
        assertEquals("9/15 – 10/31 · 550", trend.caption)
    }

    @Test
    fun monthlyTotalsDoNotExtendTheHeatmap() {
        val today = LocalDate.of(2026, 10, 31)
        val snapshot = StatsSnapshot(
            allTime = PeriodSummary(totalTokens = 1),
            monthly = listOf(MonthUsage("2025-11", 10, 0.0), MonthUsage("2026-10", 20, 0.0)),
            daily = listOf(DayUsage("2026-10-31", 20, 0.0))
        )
        val heat = shareCards(snapshot, PeriodId.AllTime, today).filterIsInstance<ShareCard.Trend>().single().heat!!
        assertTrue(heat.cells.none { it.date.startsWith("2025-") })
        assertEquals("2026-10-25", heat.cells.first().date)
        assertEquals("2026-10-31", heat.cells.last().date)
        assertEquals("2026/10", heat.months.first().label)
        assertEquals("10/31 · 20", shareCards(snapshot, PeriodId.AllTime, today).filterIsInstance<ShareCard.Trend>().single().caption)
    }

    @Test
    fun allTimeHeatmapUsesTheDailyArchive() {
        val today = LocalDate.of(2026, 10, 31)
        val snapshot = StatsSnapshot(
            allTime = PeriodSummary(totalTokens = 1),
            monthly = listOf(MonthUsage("2024-01", 999, 0.0)),
            daily = listOf(DayUsage("2026-10-31", 5, 0.0)),
            historyDaily = listOf(
                DayUsage("2025-11-02", 10, 0.0),
                DayUsage("2026-10-01", 40, 0.0),
                DayUsage("2026-10-31", 80, 0.0)
            )
        )
        val heat = shareCards(snapshot, PeriodId.AllTime, today).filterIsInstance<ShareCard.Trend>().single().heat!!
        assertEquals("2025-11-02", heat.cells.first().date)
        assertEquals(10L, heat.cells.single { it.date == "2025-11-02" }.tokens)
        assertEquals(5L, heat.cells.single { it.date == "2026-10-31" }.tokens)
        assertTrue(heat.cells.none { it.date.startsWith("2024-") })
        assertEquals(4, heat.cells.single { it.date == "2026-10-01" }.level)
        assertEquals(2, heat.cells.single { it.date == "2025-11-02" }.level)
    }

    @Test
    fun todayAndMonthHeatmapsStayInsideTheCurrentMonth() {
        val today = LocalDate.of(2026, 10, 20)
        val snapshot = StatsSnapshot(
            today = PeriodSummary(totalTokens = 1),
            month = PeriodSummary(totalTokens = 1),
            daily = listOf(DayUsage("2026-10-20", 100, 0.0)),
            historyDaily = listOf(
                DayUsage("2025-11-02", 10_000, 0.0),
                DayUsage("2026-10-01", 20, 0.0),
                DayUsage("2026-10-20", 50, 0.0)
            )
        )
        val heat = shareCards(snapshot, PeriodId.Today, today).filterIsInstance<ShareCard.Trend>().single().heat!!
        assertTrue(heat.cells.none { it.date.startsWith("2025-") })
        assertEquals("2026-09-27", heat.cells.first().date)
        assertEquals("2026-10-20", heat.cells.last().date)
        assertEquals(4, heat.cells.single { it.date == "2026-10-20" }.level)
        assertEquals(1, heat.cells.single { it.date == "2026-10-01" }.level)
        assertEquals(ShareMark.None, heat.cells.single { it.date == "2026-10-01" }.mark)
        val month = shareCards(snapshot, PeriodId.Month, today).filterIsInstance<ShareCard.Trend>().single().heat!!
        assertEquals("2026-09-27", month.cells.first().date)
        assertEquals(ShareMark.Month, month.cells.single { it.date == "2026-10-01" }.mark)
        assertEquals(4, month.cells.single { it.date == "2026-10-20" }.level)
    }

    @Test
    fun todayComparesWithYesterdayAndOtherPeriodsDoNot() {
        val snapshot = StatsSnapshot(
            today = PeriodSummary(totalTokens = 150, costUsd = 3.0),
            month = PeriodSummary(totalTokens = 150, costUsd = 3.0),
            daily = listOf(DayUsage("2026-10-30", 100, 2.0), DayUsage("2026-10-31", 150, 3.0))
        )
        val today = shareCards(snapshot, PeriodId.Today)
        assertEquals(0.5f, today.filterIsInstance<ShareCard.Tokens>().single().change!!, 0.001f)
        assertEquals(0.5f, today.filterIsInstance<ShareCard.Cost>().single().change!!, 0.001f)
        val month = shareCards(snapshot, PeriodId.Month)
        assertNull(month.filterIsInstance<ShareCard.Tokens>().single().change)
        assertNull(month.filterIsInstance<ShareCard.Cost>().single().change)
    }

    @Test
    fun aFlatZeroSeriesIsOmitted() {
        val snapshot = StatsSnapshot(
            month = PeriodSummary(totalTokens = 10, costUsd = 1.0),
            daily = listOf(DayUsage("2026-10-01", 0, 0.0), DayUsage("2026-10-02", null, null))
        )
        assertTrue(shareCards(snapshot, PeriodId.Month, LocalDate.of(2026, 10, 2)).none { it is ShareCard.Trend })
    }
}
