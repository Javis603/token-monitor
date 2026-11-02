package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class SnapshotMergeTest {
    private val previous = StatsParser.parse(
        """
        {
          "updatedAt": "2026-05-18T00:00:00.000Z",
          "periods": { "today": { "totalTokens": 50, "costUsd": 1 } },
          "limits": { "updatedAt": "2026-05-18T00:00:00.000Z", "providers": [] },
          "devices": [
            { "deviceId": "macbook", "hostname": "mac", "stale": false, "periods": { "today": { "totalTokens": 50 } } }
          ]
        }
        """.trimIndent()
    )

    @Test
    fun unauthorizedDoesNotReplaceSnapshot() {
        val outcome = classifyStatsResponse(401, """{"error":"unauthorized"}""")
        assertEquals(HubFailure.Unauthorized, (outcome as HubOutcome.Failure).failure)
        assertSame(previous, reduceSnapshot(previous, outcome))
    }

    @Test
    fun secretRequiredAndHubStoppingAreDistinct() {
        assertEquals(
            HubFailure.SecretRequired,
            (classifyStatsResponse(503, """{"error":"secret_required"}""") as HubOutcome.Failure).failure
        )
        assertEquals(
            HubFailure.HubStopping,
            (classifyStatsResponse(503, """{"error":"hub_stopping"}""") as HubOutcome.Failure).failure
        )
        assertEquals(HubFailure.HubStopping, classifyHealth(503, """{"error":"hub_stopping"}"""))
        assertNull(classifyHealth(200, """{"ok":true}"""))
    }

    @Test
    fun malformedJsonKeepsThePreviousSnapshot() {
        val outcome = classifyStatsResponse(200, "not-json")
        assertEquals(HubFailure.Malformed, (outcome as HubOutcome.Failure).failure)
        assertEquals(50L, reduceSnapshot(previous, outcome)!!.today.totalTokens)
    }

    @Test
    fun freshnessUpdatesTimestampsWithoutReplacingUsage() {
        val outcome = classifySse(
            "freshness",
            """
            {
              "type": "freshness",
              "stats": {
                "updatedAt": "2026-05-18T01:00:00.000Z",
                "limits": { "updatedAt": "2026-05-18T01:00:00.000Z" },
                "devices": [
                  { "deviceId": "macbook", "stale": true, "ageMs": 900000, "receivedAt": "2026-05-18T00:45:00.000Z" }
                ]
              }
            }
            """.trimIndent()
        )
        val next = reduceSnapshot(previous, outcome!!)!!
        assertEquals(50L, next.today.totalTokens)
        assertEquals(1.0, next.today.costUsd, 0.0)
        assertTrue(next.devices.single().stale)
        assertEquals(900_000L, next.devices.single().ageMs)
        assertEquals("2026-05-18T01:00:00.000Z", next.updatedAt)
        assertEquals("2026-05-18T01:00:00.000Z", next.limitsUpdatedAt)
        assertTrue(next.providers.isEmpty())
    }

    @Test
    fun freshnessWithoutASnapshotStaysEmpty() {
        val outcome = classifySse("freshness", """{"stats":{"updatedAt":"2026-05-18T01:00:00.000Z"}}""")
        assertNull(reduceSnapshot(null, outcome!!))
    }

    @Test
    fun statsEventReplacesTheSnapshot() {
        val outcome = classifySse(
            "stats",
            """{"type":"stats","stats":{"periods":{"today":{"totalTokens":9}}}}"""
        )
        assertEquals(9L, (reduceSnapshot(previous, outcome!!) as StatsSnapshot).today.totalTokens)
    }
}
