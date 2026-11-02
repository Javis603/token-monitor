package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

class StatsParserTest {
    @Test
    fun parsesPeriodsClientsAndLimits() {
        val snapshot = StatsParser.parse(
            """
            {
              "updatedAt": "2026-05-18T18:02:19.459Z",
              "staleAfterMs": 600000,
              "periods": {
                "today": {
                  "totalTokens": 1234567,
                  "costUsd": 1.25,
                  "clients": { "codex": 400000, "claude": 834567 },
                  "clientCosts": { "codex": 0.4, "claude": 0.85 }
                },
                "month": { "totalTokens": 9000000, "costUsd": 12.5 },
                "allTime": { "totalTokens": 42000000000, "costUsd": 80 }
              },
              "limits": {
                "updatedAt": "2026-05-18T18:00:00.000Z",
                "providers": [
                  {
                    "provider": "codex",
                    "accountKey": "sha256:abc",
                    "status": "ok",
                    "stale": false,
                    "planLabel": "Plus",
                    "windows": [
                      { "kind": "session", "label": "5h", "usedPercent": 42, "resetsAt": "2026-05-18T21:00:00.000Z" },
                      { "kind": "weekly", "usedPercent": 20, "showMeter": true }
                    ]
                  }
                ]
              },
              "devices": [
                {
                  "deviceId": "macbook",
                  "hostname": "macbook.local",
                  "stale": false,
                  "ageMs": 28000,
                  "periods": { "today": { "totalTokens": 100 } }
                }
              ]
            }
            """.trimIndent()
        )

        assertEquals(1_234_567L, snapshot.today.totalTokens)
        assertEquals(1.25, snapshot.today.costUsd, 0.0001)
        assertEquals(listOf("claude", "codex"), snapshot.today.clients.map { it.id })
        assertEquals(834_567L, snapshot.today.clients[0].tokens)
        assertEquals(0.85, snapshot.today.clients[0].costUsd, 0.0001)
        assertEquals(9_000_000L, snapshot.month.totalTokens)
        assertEquals(12.5, snapshot.month.costUsd, 0.0001)
        assertEquals(42_000_000_000L, snapshot.allTime.totalTokens)
        assertEquals("Plus", snapshot.providers.single().planLabel)
        assertEquals("sha256:abc", snapshot.providers.single().accountKey)
        assertEquals(42.0, snapshot.providers.single().windows[0].usedPercent!!, 0.001)
        assertEquals("5h", snapshot.providers.single().windows[0].label)
        assertEquals("weekly", snapshot.providers.single().windows[1].label)
        assertEquals("macbook.local", snapshot.devices.single().hostname)
        assertEquals(100L, snapshot.devices.single().todayTokens)
        assertFalse(snapshot.anyDeviceStale)
    }

    @Test
    fun creditsWithoutPercentStayUnmetered() {
        val snapshot = StatsParser.parse(
            """
            {
              "limits": {
                "providers": [
                  {
                    "provider": "deepseek",
                    "accountLabel": "API",
                    "windows": [
                      { "metric": "credits", "label": "Balance", "remaining": 12.5, "currency": "CNY", "showMeter": false }
                    ]
                  }
                ]
              }
            }
            """.trimIndent()
        )
        val window = snapshot.providers.single().windows.single()
        assertEquals("API", snapshot.providers.single().planLabel)
        assertNull(window.usedPercent)
        assertEquals(12.5, window.remaining!!, 0.001)
        assertEquals("CNY", window.currency)
        assertEquals("credits", window.metric)
        assertFalse(window.showMeter)
        assertTrue(snapshot.meteredWindows().isEmpty())
    }

    @Test
    fun missingFieldsOnOlderPayloadsStayEmpty() {
        val snapshot = StatsParser.parse("""{"periods":{"today":{"totalTokens":10}}}""")
        assertEquals(10L, snapshot.today.totalTokens)
        assertEquals(0.0, snapshot.today.costUsd, 0.0)
        assertEquals(0L, snapshot.month.totalTokens)
        assertEquals(0L, snapshot.allTime.totalTokens)
        assertTrue(snapshot.devices.isEmpty())
        assertTrue(snapshot.providers.isEmpty())
        assertTrue(snapshot.today.models.isEmpty())
        assertTrue(snapshot.week.isEmpty())
    }

    @Test
    fun modelsKeepWireIdsAndAppendTheTokenGap() {
        val snapshot = StatsParser.parse(
            """
            {
              "periods": {
                "today": {
                  "totalTokens": 100,
                  "costUsd": 1.5,
                  "models": { "gpt-5.5": 60, "claude-opus": 10 },
                  "modelCosts": { "gpt-5.5": 0.9, "claude-opus": 0.2 }
                }
              }
            }
            """.trimIndent()
        )
        val models = snapshot.today.models
        assertEquals(listOf("gpt-5.5", UNATTRIBUTED_ID, "claude-opus"), models.map { it.id })
        assertEquals(60L, models[0].tokens)
        assertEquals(0.9, models[0].costUsd, 0.0001)
        assertEquals(30L, models[1].tokens)
        assertEquals(0.4, models[1].costUsd, 0.0001)
        assertEquals(10L, models[2].tokens)
    }

    @Test
    fun clientModelsBecomeToolModelGroups() {
        val snapshot = StatsParser.parse(
            """
            {
              "periods": {
                "today": {
                  "totalTokens": 100,
                  "clientModels": {
                    "codex": { "gpt-5.5": 70, "gpt-5": 0 },
                    "claude": { "claude-opus": 30 }
                  }
                }
              }
            }
            """.trimIndent()
        )
        val groups = snapshot.today.toolModels
        assertEquals(listOf("codex", "claude"), groups.map { it.toolId })
        assertEquals(listOf("gpt-5.5"), groups[0].models.map { it.id })
        assertEquals(70L, groups[0].models.single().tokens)
        assertEquals(30L, groups[1].models.single().tokens)
    }

    @Test
    fun completeModelMapDoesNotInventUnattributed() {
        val snapshot = StatsParser.parse(
            """{"periods":{"today":{"totalTokens":100,"models":{"gpt-5.5":100}}}}"""
        )
        assertEquals(listOf("gpt-5.5"), snapshot.today.models.map { it.id })
    }

    @Test
    fun missingModelsStayEmptyEvenWhenThePeriodHasTokens() {
        val snapshot = StatsParser.parse("""{"periods":{"today":{"totalTokens":100}}}""")
        assertTrue(snapshot.today.models.isEmpty())
    }

    @Test
    fun devicePeriodsAndWeekAlignToTheSuppliedDay() {
        val snapshot = StatsParser.parse(
            """
            {
              "periods": { "today": { "totalTokens": 80 } },
              "historyPreview": {
                "daily": [
                  { "date": "2026-05-12", "tokens": 5 },
                  { "date": "2026-05-16", "tokens": 100 },
                  { "date": "2026-05-18", "tokens": 1 },
                  { "date": "2026-05-01", "tokens": 999 },
                  { "date": "not-a-day", "tokens": 4 }
                ]
              },
              "devices": [
                {
                  "deviceId": "macbook",
                  "hostname": "",
                  "periods": {
                    "today": { "totalTokens": 80, "sessions": { "a": { "totalTokens": 80 } } },
                    "month": { "totalTokens": 400 },
                    "allTime": { "totalTokens": 900 }
                  }
                }
              ]
            }
            """.trimIndent(),
            LocalDate.of(2026, 5, 18)
        )
        val device = snapshot.devices.single()
        assertEquals("macbook", device.hostname)
        assertEquals(80L, device.tokens(PeriodId.Today))
        assertEquals(400L, device.tokens(PeriodId.Month))
        assertEquals(900L, device.tokens(PeriodId.AllTime))
        assertEquals(
            listOf("2026-05-12", "2026-05-13", "2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17", "2026-05-18"),
            snapshot.week.map { it.date }
        )
        assertEquals(listOf(5L, null, null, null, 100L, null, 80L), snapshot.week.map { it.tokens })
    }

    @Test
    fun historyPreviewFeedsOverviewAndTrends() {
        val snapshot = StatsParser.parse(
            """
            {
              "periods": { "today": { "totalTokens": 80, "costUsd": 1.5 } },
              "historyPreview": {
                "daily": [
                  { "date": "2026-05-16", "tokens": 100, "cost": 2.5 },
                  { "date": "2026-05-18", "tokens": 1, "cost": 0.1 }
                ],
                "monthly": [
                  { "month": "2026-05", "tokens": 900, "cost": 12 },
                  { "month": "2026-04", "tokens": 100, "cost": 1 }
                ],
                "summary": {
                  "totalTokens": 5000,
                  "totalCost": 20,
                  "activeDays": 12,
                  "currentStreak": 3,
                  "peakDayTokens": 800,
                  "favoriteModel": "gpt-5.5",
                  "messages": 40,
                  "activeTimeMs": 5400000
                }
              }
            }
            """.trimIndent(),
            LocalDate.of(2026, 5, 18)
        )
        assertEquals(30, snapshot.daily.size)
        assertEquals(80L, snapshot.daily.last().tokens)
        assertEquals(1.5, snapshot.daily.last().costUsd!!, 0.0001)
        assertEquals(100L, snapshot.daily.first { it.date == "2026-05-16" }.tokens)
        assertEquals(null, snapshot.daily.first { it.date == "2026-05-15" }.tokens)
        assertEquals(12, snapshot.monthly.size)
        assertEquals(900L, snapshot.monthly.last().tokens)
        assertEquals(100L, snapshot.monthly.first { it.month == "2026-04" }.tokens)
        val summary = snapshot.history!!
        assertEquals(5000L, summary.totalTokens)
        assertEquals(20.0, summary.costUsd, 0.0001)
        assertEquals(12, summary.activeDays)
        assertEquals(3, summary.currentStreak)
        assertEquals(800L, summary.peakDayTokens)
        assertEquals("gpt-5.5", summary.favoriteModel)
        assertEquals(40L, summary.messages)
        assertEquals(5_400_000L, summary.activeTimeMs)
    }

    @Test
    fun historyPayloadKeepsEveryDayAndStatsKeepTheRevision() {
        val snapshot = StatsParser.parse(
            """{"historyRevision":"rev-1","periods":{"today":{"totalTokens":1}}}""",
            LocalDate.of(2026, 10, 31)
        )
        assertEquals("rev-1", snapshot.historyRevision)
        val days = StatsParser.parseHistoryDays(
            """
            {
              "daily": [
                { "date": "2026-10-31T00:00:00.000Z", "tokens": 20, "cost": 2 },
                { "date": "not-a-day", "tokens": 9 },
                { "date": "2025-11-02", "tokens": 10, "cost": 1 }
              ],
              "monthly": [{ "month": "2024-01", "tokens": 999 }]
            }
            """.trimIndent()
        )
        assertEquals(listOf("2025-11-02", "2026-10-31"), days.map { it.date })
        assertEquals(10L, days.first().tokens)
        assertEquals(1.0, days.first().costUsd!!, 0.0001)
    }

    @Test
    fun laterStatsKeepTheDailyArchiveAndPatchToday() {
        val previous = StatsSnapshot(
            historyRevision = "old",
            historyDaily = listOf(DayUsage("2026-10-30", 1, 0.0), DayUsage("2026-10-31", 2, 0.0))
        )
        val next = StatsSnapshot(
            historyRevision = "new",
            daily = listOf(DayUsage("2026-10-31", 9, 1.0))
        )
        val reduced = reduceSnapshot(previous, HubOutcome.Stats(next))!!
        assertEquals("new", reduced.historyRevision)
        assertEquals(1L, reduced.historyDaily.single { it.date == "2026-10-30" }.tokens)
        assertEquals(9L, reduced.historyDaily.single { it.date == "2026-10-31" }.tokens)
        assertEquals(1.0, reduced.historyDaily.single { it.date == "2026-10-31" }.costUsd!!, 0.0001)
    }

    @Test
    fun nullHistoryPreviewLeavesTheWeekEmpty() {
        val snapshot = StatsParser.parse("""{"historyPreview":null,"periods":{"today":{"totalTokens":10}}}""")
        assertTrue(snapshot.week.isEmpty())
    }

    @Test
    fun showMeterFalseIsExcludedFromMeteredWindows() {
        val snapshot = StatsParser.parse(
            """
            {
              "limits": {
                "providers": [
                  {
                    "provider": "claude",
                    "windows": [
                      { "label": "Hidden", "usedPercent": 90, "showMeter": false },
                      { "label": "Weekly", "usedPercent": 15 }
                    ]
                  }
                ]
              }
            }
            """.trimIndent()
        )
        val metered = snapshot.meteredWindows()
        assertEquals(1, metered.size)
        assertEquals("Weekly", metered.single().label)
        assertEquals(15.0, metered.single().usedPercent, 0.001)
    }
}
