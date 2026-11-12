package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class SurfaceStampTest {
    private val device = DeviceSummary(deviceId = "mac", hostname = "mac", stale = false, ageMs = 1_000)

    private val snapshot = StatsSnapshot(
        updatedAt = "2026-05-18T01:00:10.000Z",
        today = PeriodSummary(
            totalTokens = 50,
            costUsd = 1.25,
            clients = listOf(ClientUsage("cursor", 40, 1.0)),
            models = listOf(ClientUsage("gpt-5", 40, 1.0))
        ),
        month = PeriodSummary(totalTokens = 80, costUsd = 2.5),
        week = listOf(DayUsage("2026-05-12", 10, 0.2), DayUsage("2026-05-18", 50, 1.25)),
        devices = listOf(device),
        providers = listOf(
            LimitProvider(
                provider = "openai",
                status = "ok",
                stale = false,
                planLabel = "Plus",
                windows = listOf(LimitWindow(label = "5h", kind = "5h", usedPercent = 10.0))
            )
        )
    )

    @Test
    fun ageWithinTheSameMinuteDoesNotChangeTheStamp() {
        val older = snapshot.copy(devices = listOf(device.copy(ageMs = 90_000)))
        val later = snapshot.copy(updatedAt = "2026-05-18T01:00:50.000Z")
        assertEquals(snapshot.surfaceStamp(), older.surfaceStamp())
        assertEquals(snapshot.surfaceStamp(), later.surfaceStamp())
    }

    @Test
    fun usageCostWeekAndQuotaChangeTheStamp() {
        val base = snapshot.surfaceStamp()
        assertNotEquals(base, snapshot.copy(today = snapshot.today.copy(totalTokens = 51)).surfaceStamp())
        assertNotEquals(base, snapshot.copy(today = snapshot.today.copy(costUsd = 3.0)).surfaceStamp())
        assertNotEquals(base, snapshot.copy(month = snapshot.month.copy(totalTokens = 90)).surfaceStamp())
        assertNotEquals(base, snapshot.copy(month = snapshot.month.copy(costUsd = 4.0)).surfaceStamp())
        assertNotEquals(
            base,
            snapshot.copy(week = listOf(DayUsage("2026-05-12", 11, 0.2), DayUsage("2026-05-18", 50, 1.25))).surfaceStamp()
        )
        val raised = snapshot.copy(
            providers = listOf(snapshot.providers.single().copy(windows = listOf(LimitWindow(label = "5h", kind = "5h", usedPercent = 40.0))))
        )
        assertNotEquals(base, raised.surfaceStamp())
        assertEquals(40, raised.surfaceStamp().topQuotaPercent)
    }

    @Test
    fun staleAndTopUsageChangeTheStamp() {
        val base = snapshot.surfaceStamp()
        assertNotEquals(base, snapshot.copy(devices = listOf(device.copy(stale = true))).surfaceStamp())
        assertNotEquals(
            base,
            snapshot.copy(today = snapshot.today.copy(models = listOf(ClientUsage("opus", 40, 1.0)))).surfaceStamp()
        )
        assertNotEquals(
            base,
            snapshot.copy(today = snapshot.today.copy(clients = listOf(ClientUsage("codex", 40, 1.0)))).surfaceStamp()
        )
    }

    @Test
    fun aNewMinuteChangesTheStamp() {
        assertNotEquals(
            snapshot.surfaceStamp(),
            snapshot.copy(updatedAt = "2026-05-18T01:01:10.000Z").surfaceStamp()
        )
    }
}
