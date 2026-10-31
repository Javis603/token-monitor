package com.javis.tokenmonitor.remote.core

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters

sealed interface ShareCard {
    data class Tokens(
        val tokens: Long,
        val costUsd: Double,
        val change: Float? = null,
        val bars: List<ShareBar> = emptyList(),
        val axisStart: String = "",
        val axisEnd: String = ""
    ) : ShareCard
    data class Cost(
        val costUsd: Double,
        val tokens: Long,
        val change: Float? = null,
        val series: List<Double> = emptyList(),
        val start: String = "",
        val end: String = ""
    ) : ShareCard
    data class Models(val rows: List<ShareRank>) : ShareCard
    data class Tools(val rows: List<ShareRank>) : ShareCard
    data class Trend(
        val bars: List<ShareBar> = emptyList(),
        val caption: String = "",
        val heat: ShareHeat? = null,
        val axisStart: String = "",
        val axisEnd: String = ""
    ) : ShareCard
}

data class ShareRank(val id: String, val tokens: Long, val fraction: Float)

data class ShareBar(val tokens: Long, val label: String)

enum class ShareMark { None, Month, Today }

data class ShareCell(
    val date: String,
    val tokens: Long,
    val level: Int,
    val mark: ShareMark,
    val column: Int,
    val row: Int
)

data class ShareMonthLabel(val column: Int, val label: String)

data class ShareHeat(
    val cells: List<ShareCell>,
    val weeks: Int,
    val months: List<ShareMonthLabel>,
    val start: String = "",
    val end: String = ""
)

fun shareCards(snapshot: StatsSnapshot, period: PeriodId, today: LocalDate = LocalDate.now()): List<ShareCard> {
    val summary = snapshot.period(period)
    val cards = mutableListOf<ShareCard>()
    val chart = periodChart(snapshot, period, today)
    if (summary.totalTokens > 0 || (summary.costUsd.isFinite() && summary.costUsd != 0.0)) {
        val yesterday = if (period == PeriodId.Today) snapshot.daily.dropLast(1).lastOrNull() else null
        cards += ShareCard.Tokens(
            summary.totalTokens,
            summary.costUsd,
            changeRatio(summary.totalTokens.toDouble(), yesterday?.tokens?.toDouble()),
            chart.bars,
            chart.start,
            chart.end
        )
        cards += ShareCard.Cost(
            summary.costUsd,
            summary.totalTokens,
            changeRatio(summary.costUsd, yesterday?.costUsd),
            costSeries(snapshot, period, today),
            chart.start,
            chart.end
        )
    }
    ranks(summary.models, summary.totalTokens)?.let { cards += ShareCard.Models(it) }
    ranks(summary.clients, summary.totalTokens)?.let { cards += ShareCard.Tools(it) }
    trend(chart)?.let { cards += it }
    return cards
}

private fun ranks(rows: List<ClientUsage>, total: Long): List<ShareRank>? {
    if (total <= 0L) return null
    val visible = rows.filter { it.tokens > 0 }.sortedByDescending { it.tokens }.take(3)
    if (visible.isEmpty()) return null
    return visible.map { row ->
        ShareRank(row.id, row.tokens, (row.tokens.toDouble() / total.toDouble()).toFloat().coerceIn(0f, 1f))
    }
}

private data class PeriodChart(
    val bars: List<ShareBar>,
    val heat: ShareHeat?,
    val start: String,
    val end: String
)

private fun periodChart(snapshot: StatsSnapshot, period: PeriodId, today: LocalDate): PeriodChart {
    val bars = when (period) {
        PeriodId.Today -> monthDayBars(snapshot, today)
        PeriodId.Month -> monthWeekBars(snapshot, today)
        PeriodId.AllTime -> allTimeMonthBars(snapshot, today)
    }
    val start = when (period) {
        PeriodId.AllTime -> bars.firstOrNull()?.label.orEmpty()
        else -> shareDateLabel(today.withDayOfMonth(1).toString())
    }
    val end = when (period) {
        PeriodId.AllTime -> bars.lastOrNull()?.label.orEmpty()
        else -> shareDateLabel(today.toString())
    }
    return PeriodChart(bars, historyHeat(snapshot, today, period), start, end)
}

private fun monthDayBars(snapshot: StatsSnapshot, today: LocalDate): List<ShareBar> {
    val tokens = tokenByDate(snapshot)
    return daysOfMonth(today).map { day ->
        ShareBar(tokens[day.toString()] ?: 0L, shareDateLabel(day.toString()))
    }
}

private fun monthWeekBars(snapshot: StatsSnapshot, today: LocalDate): List<ShareBar> {
    val tokens = tokenByDate(snapshot)
    return daysOfMonth(today)
        .groupBy { it.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)) }
        .toSortedMap()
        .map { (_, days) ->
            val first = shareDateLabel(days.first().toString())
            val last = shareDateLabel(days.last().toString())
            ShareBar(days.sumOf { tokens[it.toString()] ?: 0L }, if (first == last) first else "$first–$last")
        }
}

private data class MonthBucket(val key: String, val tokens: Long, val cost: Double)

private fun allTimeMonths(snapshot: StatsSnapshot, today: LocalDate): List<MonthBucket> {
    val tokens = linkedMapOf<String, Long>()
    val costs = linkedMapOf<String, Double>()
    snapshot.monthly.forEach { month ->
        val key = month.month.take(7)
        if (key.length == 7) {
            tokens[key] = month.tokens
            costs[key] = month.costUsd
        }
    }
    if (tokens.isEmpty()) {
        snapshot.daily.forEach { day ->
            val key = day.date.take(7)
            if (key.length == 7) {
                tokens[key] = (tokens[key] ?: 0L) + (day.tokens ?: 0L)
                costs[key] = (costs[key] ?: 0.0) + (day.costUsd ?: 0.0)
            }
        }
    }
    val keys = tokens.keys.filter { it.length == 7 }.sorted()
    if (keys.isEmpty()) return emptyList()
    val start = LocalDate.parse("${keys.first()}-01")
    val end = maxOf(LocalDate.parse("${keys.last()}-01"), today.withDayOfMonth(1))
    val rows = mutableListOf<MonthBucket>()
    var cursor = start
    while (!cursor.isAfter(end)) {
        val key = cursor.toString().take(7)
        rows += MonthBucket(key, tokens[key] ?: 0L, costs[key] ?: 0.0)
        cursor = cursor.plusMonths(1)
    }
    val first = rows.indexOfFirst { it.tokens > 0L }
    return if (first < 0) emptyList() else rows.drop(first)
}

private fun allTimeMonthBars(snapshot: StatsSnapshot, today: LocalDate): List<ShareBar> =
    allTimeMonths(snapshot, today).map { ShareBar(it.tokens, shareDateLabel(it.key)) }

private fun historyHeat(snapshot: StatsSnapshot, today: LocalDate, period: PeriodId): ShareHeat {
    val tokens = tokenByDate(snapshot)
    val rangeStart = heatStart(tokens.keys, today, period)
    val gridStart = rangeStart.minusDays((rangeStart.dayOfWeek.value % 7).toLong())
    val monthKey = today.toString().take(7)
    val todayKey = today.toString()
    val dates = mutableListOf<LocalDate>()
    var cursor = gridStart
    while (!cursor.isAfter(today)) {
        dates += cursor
        cursor = cursor.plusDays(1)
    }
    val max = dates.filter { !it.isBefore(rangeStart) }.maxOfOrNull { tokens[it.toString()] ?: 0L } ?: 0L
    val months = mutableListOf<ShareMonthLabel>()
    val seen = mutableSetOf<String>()
    val cells = dates.map { date ->
        val key = date.toString()
        val column = ChronoUnit.DAYS.between(gridStart, date).toInt() / 7
        val month = key.take(7)
        if ((date.dayOfMonth == 1 || date == rangeStart) && seen.add(month)) {
            val label = if (months.isEmpty() || date.monthValue == 1) {
                "${date.year}/${date.monthValue}"
            } else {
                "${date.monthValue}月"
            }
            months += ShareMonthLabel(column, label)
        }
        val value = tokens[key] ?: 0L
        val mark = when {
            key == todayKey -> ShareMark.Today
            period != PeriodId.Today && key.startsWith(monthKey) -> ShareMark.Month
            else -> ShareMark.None
        }
        ShareCell(key, value, heatLevel(value, max), mark, column, date.dayOfWeek.value % 7)
    }
    val weeks = if (cells.isEmpty()) 0 else cells.maxOf { it.column } + 1
    return ShareHeat(cells, weeks, months, shareDateLabel(rangeStart.toString()), shareDateLabel(today.toString()))
}

private fun heatStart(dates: Set<String>, today: LocalDate, period: PeriodId): LocalDate {
    if (period != PeriodId.AllTime) return today.withDayOfMonth(1).let { if (it.isAfter(today)) today else it }
    val first = dates.filter { it.length == 10 }.minOrNull()?.let { LocalDate.parse(it) } ?: return today.withDayOfMonth(1)
    return if (first.isAfter(today)) today else first
}

private fun daysOfMonth(today: LocalDate): List<LocalDate> {
    val days = mutableListOf<LocalDate>()
    var cursor = today.withDayOfMonth(1)
    while (!cursor.isAfter(today)) {
        days += cursor
        cursor = cursor.plusDays(1)
    }
    return days
}

private fun tokenByDate(snapshot: StatsSnapshot): Map<String, Long> {
    val merged = linkedMapOf<String, Long>()
    snapshot.historyDaily.forEach { day ->
        val key = day.date.take(10)
        if (key.length == 10) merged[key] = day.tokens ?: 0L
    }
    snapshot.daily.forEach { day ->
        val key = day.date.take(10)
        if (key.length == 10 && day.tokens != null) merged[key] = day.tokens
    }
    return merged
}

private fun costSeries(snapshot: StatsSnapshot, period: PeriodId, today: LocalDate): List<Double> {
    val costs = snapshot.daily.associate { it.date.take(10) to (it.costUsd ?: 0.0) }
    return when (period) {
        PeriodId.Today -> daysOfMonth(today).map { costs[it.toString()] ?: 0.0 }
        PeriodId.Month -> daysOfMonth(today)
            .groupBy { it.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)) }
            .toSortedMap()
            .map { (_, days) -> days.sumOf { costs[it.toString()] ?: 0.0 } }
        PeriodId.AllTime -> allTimeMonths(snapshot, today).map { it.cost }
    }
}

private fun heatLevel(tokens: Long, max: Long): Int {
    if (max <= 0L || tokens <= 0L) return 0
    val ratio = tokens.toDouble() / max.toDouble()
    return when {
        ratio >= 0.75 -> 4
        ratio >= 0.5 -> 3
        ratio >= 0.25 -> 2
        else -> 1
    }
}

private fun changeRatio(current: Double, previous: Double?): Float? {
    if (previous == null || !previous.isFinite() || previous <= 0.0 || !current.isFinite()) return null
    return ((current - previous) / previous).toFloat()
}

private fun trend(chart: PeriodChart): ShareCard.Trend? {
    val heat = chart.heat
    if (heat != null) {
        if (heat.cells.all { it.tokens <= 0L }) return null
        return ShareCard.Trend(
            emptyList(),
            shareTrendCaption(heat.start, heat.end, heat.cells.sumOf { it.tokens }),
            heat,
            heat.start,
            heat.end
        )
    }
    if (chart.bars.isEmpty() || chart.bars.all { it.tokens <= 0L }) return null
    return ShareCard.Trend(
        chart.bars,
        shareTrendCaption(chart.start, chart.end, chart.bars.sumOf { it.tokens }),
        axisStart = chart.start,
        axisEnd = chart.end
    )
}

internal fun shareDateLabel(date: String): String {
    val parts = date.split("-")
    val month = parts.getOrNull(1)?.toIntOrNull()
    return when (parts.size) {
        3 -> {
            val day = parts.getOrNull(2)?.toIntOrNull() ?: return date
            if (month == null) date else "$month/$day"
        }
        2 -> if (month == null) date else "${parts[0]}/$month"
        else -> date
    }
}

internal fun shareTrendCaption(start: String, end: String, tokens: Long): String {
    val range = if (start == end) start else "$start – $end"
    return "$range · ${Format.compactTokens(tokens)}"
}
