package com.javis.tokenmonitor.remote.core

import kotlinx.serialization.Serializable

enum class PeriodId {
    Today,
    Month,
    AllTime
}

const val UNATTRIBUTED_ID = "\u0000unattributed"

@Serializable
data class ClientUsage(
    val id: String,
    val tokens: Long,
    val costUsd: Double
)

@Serializable
data class ToolModelUsage(
    val toolId: String,
    val models: List<ClientUsage> = emptyList()
)

@Serializable
data class PeriodSummary(
    val totalTokens: Long = 0,
    val costUsd: Double = 0.0,
    val clients: List<ClientUsage> = emptyList(),
    val models: List<ClientUsage> = emptyList(),
    val toolModels: List<ToolModelUsage> = emptyList()
)

@Serializable
data class LimitWindow(
    val label: String,
    val kind: String,
    val usedPercent: Double? = null,
    val remaining: Double? = null,
    val currency: String? = null,
    val metric: String? = null,
    val resetsAt: String? = null,
    val showMeter: Boolean = true
)

@Serializable
data class LimitProvider(
    val provider: String,
    val status: String,
    val stale: Boolean,
    val planLabel: String,
    val accountKey: String = "",
    val windows: List<LimitWindow> = emptyList()
)

@Serializable
data class DeviceSummary(
    val deviceId: String,
    val hostname: String,
    val stale: Boolean,
    val ageMs: Long? = null,
    val todayTokens: Long = 0,
    val monthTokens: Long = 0,
    val allTimeTokens: Long = 0,
    val updatedAt: String? = null,
    val receivedAt: String? = null
) {
    fun tokens(period: PeriodId): Long = when (period) {
        PeriodId.Today -> todayTokens
        PeriodId.Month -> monthTokens
        PeriodId.AllTime -> allTimeTokens
    }
}

@Serializable
data class DayUsage(
    val date: String,
    val tokens: Long? = null,
    val costUsd: Double? = null
)

@Serializable
data class MonthUsage(
    val month: String,
    val tokens: Long = 0,
    val costUsd: Double = 0.0
)

@Serializable
data class HistorySummary(
    val totalTokens: Long = 0,
    val costUsd: Double = 0.0,
    val activeDays: Int = 0,
    val currentStreak: Int = 0,
    val peakDayTokens: Long = 0,
    val favoriteModel: String = "",
    val messages: Long = 0,
    val activeTimeMs: Long = 0
)

@Serializable
data class StatsSnapshot(
    val updatedAt: String = "",
    val staleAfterMs: Long? = null,
    val today: PeriodSummary = PeriodSummary(),
    val month: PeriodSummary = PeriodSummary(),
    val allTime: PeriodSummary = PeriodSummary(),
    val providers: List<LimitProvider> = emptyList(),
    val limitsUpdatedAt: String? = null,
    val devices: List<DeviceSummary> = emptyList(),
    val week: List<DayUsage> = emptyList(),
    val daily: List<DayUsage> = emptyList(),
    val monthly: List<MonthUsage> = emptyList(),
    val history: HistorySummary? = null,
    val historyRevision: String = "",
    val historyDaily: List<DayUsage> = emptyList()
) {
    fun period(id: PeriodId): PeriodSummary = when (id) {
        PeriodId.Today -> today
        PeriodId.Month -> month
        PeriodId.AllTime -> allTime
    }

    val anyDeviceStale: Boolean
        get() = devices.any { it.stale }
}

data class MeteredWindow(
    val provider: String,
    val label: String,
    val usedPercent: Double
)

fun StatsSnapshot.meteredWindows(): List<MeteredWindow> {
    return providers.flatMap { provider ->
        provider.windows.mapNotNull { window ->
            val percent = window.usedPercent
            if (percent == null || !window.showMeter || !percent.isFinite() || percent < 0) null
            else MeteredWindow(provider.provider, window.label.ifBlank { window.kind }, percent)
        }
    }.sortedByDescending { it.usedPercent }
}

enum class HubFailure {
    Unreachable,
    Unauthorized,
    SecretRequired,
    HubStopping,
    Malformed
}

data class DeviceFreshness(
    val deviceId: String,
    val updatedAt: String? = null,
    val receivedAt: String? = null,
    val ageMs: Long? = null,
    val stale: Boolean? = null
)

data class FreshnessUpdate(
    val updatedAt: String? = null,
    val staleAfterMs: Long? = null,
    val limitsUpdatedAt: String? = null,
    val devices: List<DeviceFreshness> = emptyList()
)

sealed class HubOutcome {
    data class Stats(val snapshot: StatsSnapshot) : HubOutcome()
    data class Freshness(val update: FreshnessUpdate) : HubOutcome()
    data class Failure(val failure: HubFailure) : HubOutcome()
}

fun StatsSnapshot.applyFreshness(update: FreshnessUpdate): StatsSnapshot {
    val byId = update.devices.associateBy { it.deviceId }
    return copy(
        updatedAt = update.updatedAt ?: updatedAt,
        staleAfterMs = update.staleAfterMs ?: staleAfterMs,
        limitsUpdatedAt = update.limitsUpdatedAt ?: limitsUpdatedAt,
        devices = devices.map { device ->
            val fresh = byId[device.deviceId] ?: return@map device
            device.copy(
                updatedAt = fresh.updatedAt ?: device.updatedAt,
                receivedAt = fresh.receivedAt ?: device.receivedAt,
                ageMs = fresh.ageMs ?: device.ageMs,
                stale = fresh.stale ?: device.stale
            )
        }
    )
}

fun reduceSnapshot(previous: StatsSnapshot?, outcome: HubOutcome): StatsSnapshot? = when (outcome) {
    is HubOutcome.Stats -> outcome.snapshot.retainDailyArchive(previous)
    is HubOutcome.Freshness -> previous?.applyFreshness(outcome.update)
    is HubOutcome.Failure -> previous
}

private fun StatsSnapshot.retainDailyArchive(previous: StatsSnapshot?): StatsSnapshot {
    val archived = previous?.historyDaily.orEmpty()
    if (archived.isEmpty()) return this
    return copy(historyDaily = archived.overlayLiveToday(daily))
}

fun List<DayUsage>.overlayLiveToday(preview: List<DayUsage>): List<DayUsage> {
    val today = preview.lastOrNull() ?: return this
    val key = today.date.take(10)
    if (!Regex("""\d{4}-\d{2}-\d{2}""").matches(key)) return this
    val patched = map { row ->
        if (row.date.take(10) == key) row.copy(tokens = today.tokens, costUsd = today.costUsd) else row
    }
    return if (patched.any { it.date.take(10) == key }) patched else patched + today
}
