package com.javis.tokenmonitor.remote.core

import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import kotlin.math.roundToInt

data class SurfaceStamp(
    val todayTokens: Long,
    val todayCostUsd: Double,
    val monthTokens: Long,
    val monthCostUsd: Double,
    val weekTokens: List<Long?>,
    val topModelId: String?,
    val topModelTokens: Long?,
    val topToolId: String?,
    val topToolTokens: Long?,
    val anyDeviceStale: Boolean,
    val updatedMinute: String,
    val topQuotaPercent: Int?,
    val topQuotaProvider: String?,
    val topQuotaLabel: String?
)

fun StatsSnapshot.surfaceStamp(zone: ZoneId = ZoneId.systemDefault()): SurfaceStamp {
    val model = today.models.firstOrNull { it.tokens > 0 }
    val tool = today.clients.firstOrNull { it.tokens > 0 }
    val meter = meteredWindows().firstOrNull()
    return SurfaceStamp(
        todayTokens = today.totalTokens,
        todayCostUsd = displayedCost(today.costUsd),
        monthTokens = month.totalTokens,
        monthCostUsd = displayedCost(month.costUsd),
        weekTokens = week.map { it.tokens },
        topModelId = model?.id,
        topModelTokens = model?.tokens,
        topToolId = tool?.id,
        topToolTokens = tool?.tokens,
        anyDeviceStale = anyDeviceStale,
        updatedMinute = updatedMinute(updatedAt, zone),
        topQuotaPercent = meter?.usedPercent?.roundToInt()?.coerceAtLeast(0),
        topQuotaProvider = meter?.provider,
        topQuotaLabel = meter?.label
    )
}

private fun displayedCost(value: Double): Double = if (value.isFinite()) value else 0.0

private fun updatedMinute(updatedAt: String, zone: ZoneId): String {
    val instant = runCatching { Instant.parse(updatedAt) }.getOrNull() ?: return ""
    return instant.atZone(zone).truncatedTo(ChronoUnit.MINUTES).toString()
}
