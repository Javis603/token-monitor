package com.javis.tokenmonitor.remote.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.time.LocalDate
import java.time.YearMonth
import java.time.ZoneId

object StatsParser {
    private val json = Json { ignoreUnknownKeys = true }
    private val dayKey = Regex("""\d{4}-\d{2}-\d{2}""")
    private val monthKey = Regex("""\d{4}-\d{2}""")

    fun parse(body: String, today: LocalDate = LocalDate.now(ZoneId.systemDefault())): StatsSnapshot {
        val root = json.parseToJsonElement(body).asObject()
            ?: throw IllegalArgumentException("stats root")
        return parseElement(root, today)
    }

    internal fun parseElement(root: JsonElement, today: LocalDate = LocalDate.now(ZoneId.systemDefault())): StatsSnapshot {
        val objectRoot = root.asObject() ?: throw IllegalArgumentException("stats root")
        val periods = objectRoot.child("periods")
        val limits = objectRoot.child("limits")
        val todayPeriod = period(periods?.child("today"))
        val history = history(objectRoot, today, todayPeriod)
        return StatsSnapshot(
            updatedAt = objectRoot.text("updatedAt"),
            staleAfterMs = objectRoot["staleAfterMs"].asDoubleOrNull()?.toLong(),
            today = todayPeriod,
            month = period(periods?.child("month")),
            allTime = period(periods?.child("allTime")),
            providers = providers(limits),
            limitsUpdatedAt = limits?.text("updatedAt")?.takeIf { it.isNotEmpty() },
            devices = devices(objectRoot),
            week = history.week,
            daily = history.daily,
            monthly = history.monthly,
            history = history.summary,
            historyRevision = objectRoot.text("historyRevision")
        )
    }

    private fun period(node: JsonObject?): PeriodSummary {
        if (node == null) return PeriodSummary()
        val totalTokens = node["totalTokens"].asLong()
        val costUsd = node["costUsd"].asDoubleOrNull() ?: 0.0
        return PeriodSummary(
            totalTokens = totalTokens,
            costUsd = costUsd,
            clients = attribution(node, "clients", "clientCosts", remainder = false, totalTokens, costUsd),
            models = attribution(node, "models", "modelCosts", remainder = true, totalTokens, costUsd),
            toolModels = toolModels(node)
        )
    }

    private fun toolModels(node: JsonObject): List<ToolModelUsage> {
        val tools = node["clientModels"].asObject() ?: return emptyList()
        return tools.mapNotNull { (toolId, value) ->
            if (toolId.isBlank()) return@mapNotNull null
            val models = value.asObject()?.mapNotNull { (modelId, tokens) ->
                val amount = tokens.asDoubleOrNull()?.toLong() ?: return@mapNotNull null
                if (modelId.isBlank() || amount <= 0L) return@mapNotNull null
                ClientUsage(modelId, amount, 0.0)
            }.orEmpty().sortedWith(compareByDescending<ClientUsage> { it.tokens }.thenBy { it.id })
            if (models.isEmpty()) return@mapNotNull null
            ToolModelUsage(toolId, models)
        }.sortedWith(compareByDescending<ToolModelUsage> { it.models.sumOf { model -> model.tokens } }.thenBy { it.toolId })
    }

    private fun attribution(
        node: JsonObject,
        tokensKey: String,
        costsKey: String,
        remainder: Boolean,
        totalTokens: Long,
        totalCost: Double
    ): List<ClientUsage> {
        val tokens = numberMap(node, tokensKey)
        val costs = numberMap(node, costsKey)
        val rows = (tokens.keys + costs.keys).filter { it.isNotBlank() }.map { id ->
            ClientUsage(
                id = id,
                tokens = tokens[id]?.toLong() ?: 0,
                costUsd = costs[id] ?: 0.0
            )
        }.toMutableList()
        if (remainder && rows.isNotEmpty()) {
            val gap = totalTokens - rows.sumOf { it.tokens }
            if (gap > 0) {
                val costGap = (totalCost - rows.sumOf { it.costUsd }).coerceAtLeast(0.0)
                rows += ClientUsage(UNATTRIBUTED_ID, gap, costGap)
            }
        }
        return rows.sortedWith(compareByDescending<ClientUsage> { it.tokens }.thenBy { it.id })
    }

    private fun providers(limits: JsonObject?): List<LimitProvider> {
        val array = limits?.get("providers").asArray() ?: return emptyList()
        return array.mapNotNull { element ->
            val node = element.asObject() ?: return@mapNotNull null
            val provider = node.text("provider")
            if (provider.isEmpty()) return@mapNotNull null
            val plan = node.text("planLabel").ifBlank { node.text("accountLabel") }
            LimitProvider(
                provider = provider,
                status = node.text("status").ifBlank { "ok" },
                stale = node["stale"].asBooleanOrNull() == true,
                planLabel = plan,
                accountKey = node.text("accountKey"),
                windows = windows(node)
            )
        }
    }

    private fun windows(provider: JsonObject): List<LimitWindow> {
        val array = provider["windows"].asArray() ?: return emptyList()
        return array.mapNotNull { element ->
            val node = element.asObject() ?: return@mapNotNull null
            val kind = node.text("kind")
            val label = node.text("label").ifBlank { kind }
            LimitWindow(
                label = label,
                kind = kind,
                usedPercent = node["usedPercent"].asDoubleOrNull(),
                remaining = node["remaining"].asDoubleOrNull(),
                currency = node.text("currency").takeIf { it.isNotEmpty() },
                metric = node.text("metric").takeIf { it.isNotEmpty() },
                resetsAt = node.text("resetsAt").takeIf { it.isNotEmpty() },
                showMeter = node["showMeter"].asBooleanOrNull() ?: true
            )
        }
    }

    private fun devices(root: JsonObject): List<DeviceSummary> {
        val array = root["devices"].asArray() ?: return emptyList()
        return array.mapNotNull { element ->
            val node = element.asObject() ?: return@mapNotNull null
            val deviceId = node.text("deviceId")
            if (deviceId.isEmpty()) return@mapNotNull null
            val hostname = node.text("hostname").ifBlank { deviceId }
            val periods = node.child("periods")
            DeviceSummary(
                deviceId = deviceId,
                hostname = hostname,
                stale = node["stale"].asBooleanOrNull() == true,
                ageMs = node["ageMs"].asDoubleOrNull()?.toLong(),
                todayTokens = periodTokens(periods, "today"),
                monthTokens = periodTokens(periods, "month"),
                allTimeTokens = periodTokens(periods, "allTime"),
                updatedAt = node.text("updatedAt").takeIf { it.isNotEmpty() },
                receivedAt = node.text("receivedAt").takeIf { it.isNotEmpty() }
            )
        }
    }

    private fun periodTokens(periods: JsonObject?, name: String): Long =
        periods?.child(name)?.get("totalTokens").asLong()

    private class ParsedHistory(
        val week: List<DayUsage>,
        val daily: List<DayUsage>,
        val monthly: List<MonthUsage>,
        val summary: HistorySummary?
    )

    private fun history(root: JsonObject, today: LocalDate, todayPeriod: PeriodSummary): ParsedHistory {
        val empty = ParsedHistory(emptyList(), emptyList(), emptyList(), null)
        if (!root.containsKey("historyPreview")) return empty
        val preview = root["historyPreview"]
        if (preview == null || preview is JsonNull) return empty
        val node = preview.asObject() ?: return empty
        val byDate = mutableMapOf<String, Pair<Long, Double>>()
        for (element in node["daily"].asArray().orEmpty()) {
            val day = element.asObject() ?: continue
            val date = day.text("date").take(10)
            if (!dayKey.matches(date)) continue
            byDate[date] = day["tokens"].asLong() to (day["cost"].asDoubleOrNull() ?: 0.0)
        }
        val byMonth = mutableMapOf<String, Pair<Long, Double>>()
        for (element in node["monthly"].asArray().orEmpty()) {
            val month = element.asObject() ?: continue
            val key = month.text("month").take(7)
            if (!monthKey.matches(key)) continue
            byMonth[key] = month["tokens"].asLong() to (month["cost"].asDoubleOrNull() ?: 0.0)
        }
        val todayKey = today.toString()
        fun slot(date: String): DayUsage {
            if (date == todayKey) return DayUsage(date, todayPeriod.totalTokens, todayPeriod.costUsd)
            val row = byDate[date] ?: return DayUsage(date, null, null)
            return DayUsage(date, row.first, row.second)
        }
        val week = (6 downTo 0).map { offset -> slot(today.minusDays(offset.toLong()).toString()) }
        val daily = (29 downTo 0).map { offset -> slot(today.minusDays(offset.toLong()).toString()) }
        val endMonth = YearMonth.from(today)
        val monthly = (11 downTo 0).map { offset ->
            val key = endMonth.minusMonths(offset.toLong()).toString()
            val row = byMonth[key]
            MonthUsage(key, row?.first ?: 0L, row?.second ?: 0.0)
        }
        return ParsedHistory(week, daily, monthly, summary(node.child("summary")))
    }

    private fun summary(node: JsonObject?): HistorySummary? {
        if (node == null) return null
        return HistorySummary(
            totalTokens = node["totalTokens"].asLong(),
            costUsd = node["totalCost"].asDoubleOrNull() ?: 0.0,
            activeDays = node["activeDays"].asLong().toInt(),
            currentStreak = node["currentStreak"].asLong().toInt(),
            peakDayTokens = node["peakDayTokens"].asLong(),
            favoriteModel = node.text("favoriteModel"),
            messages = node["messages"].asLong(),
            activeTimeMs = node["activeTimeMs"].asLong()
        )
    }

    fun parseHistoryDays(body: String): List<DayUsage> {
        val root = json.parseToJsonElement(body).asObject() ?: throw IllegalArgumentException("history")
        val daily = root["daily"].asArray() ?: throw IllegalArgumentException("history")
        return daily.mapNotNull { element ->
            val day = element.asObject() ?: return@mapNotNull null
            val date = day.text("date").take(10)
            if (!dayKey.matches(date)) return@mapNotNull null
            DayUsage(date, day["tokens"].asLong(), day["cost"].asDoubleOrNull() ?: 0.0)
        }.sortedBy { it.date }
    }

    private fun numberMap(node: JsonObject, name: String): Map<String, Double> {
        val objectNode = node[name].asObject() ?: return emptyMap()
        return objectNode.mapNotNull { (key, value) ->
            val number = value.asDoubleOrNull() ?: return@mapNotNull null
            key to number
        }.toMap()
    }
}
