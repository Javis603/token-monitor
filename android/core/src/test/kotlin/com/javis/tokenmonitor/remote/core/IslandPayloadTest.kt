package com.javis.tokenmonitor.remote.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IslandPayloadTest {
    private val json = Json

    @Test
    fun protocol3CarriesTheIslandAndProtocol2CarriesTicker() {
        val snapshot = StatsParser.parse(
            """
            {
              "periods": { "today": { "totalTokens": 1200000, "costUsd": 1.2 } },
              "limits": {
                "providers": [
                  {
                    "provider": "codex",
                    "windows": [
                      { "label": "Weekly", "usedPercent": 20 },
                      { "label": "5h", "usedPercent": 82.4 }
                    ]
                  }
                ]
              }
            }
            """.trimIndent()
        )

        assertNull(IslandPayload.json(snapshot, focusProtocol = 1))
        assertNull(IslandPayload.json(snapshot, focusProtocol = 0))

        val island = param(IslandPayload.json(snapshot, 3)!!)
        assertFalse(island.containsKey("ticker"))
        assertEquals("token_usage", island.getValue("business").jsonPrimitive.content)
        assertTrue(island.getValue("updatable").jsonPrimitive.boolean)
        assertFalse(island.getValue("enableFloat").jsonPrimitive.boolean)
        assertFalse(island.getValue("islandFirstFloat").jsonPrimitive.boolean)
        assertFalse(island.getValue("filterWhenNoPermission").jsonPrimitive.boolean)
        assertEquals("reopen", island.getValue("reopen").jsonPrimitive.content)
        assertEquals("1.2M", island.getValue("aodTitle").jsonPrimitive.content)
        assertEquals(
            "1.2M",
            island.getValue("param_island").jsonObject
                .getValue("bigIslandArea").jsonObject
                .getValue("imageTextInfoLeft").jsonObject
                .getValue("textInfo").jsonObject
                .getValue("title").jsonPrimitive.content
        )
        assertEquals(1, island.getValue("param_island").jsonObject.getValue("smallIslandArea").jsonObject.getValue("picInfo").jsonObject.getValue("type").jsonPrimitive.int)
        assertEquals(82, island.getValue("progressInfo").jsonObject.getValue("progress").jsonPrimitive.int)
        assertFalse(island.getValue("progressInfo").jsonObject.keys.any { it.startsWith("pic") })
        val base = island.getValue("baseInfo").jsonObject
        assertEquals(2, base.getValue("type").jsonPrimitive.int)
        assertEquals("codex 5h", base.getValue("title").jsonPrimitive.content)
        assertEquals("82%", base.getValue("content").jsonPrimitive.content)

        val focus = param(IslandPayload.json(snapshot, 2)!!)
        assertEquals("1.2M", focus.getValue("ticker").jsonPrimitive.content)
        assertFalse(focus.containsKey("param_island"))
        assertEquals(82, focus.getValue("progressInfo").jsonObject.getValue("progress").jsonPrimitive.int)
    }

    @Test
    fun withoutAPercentTheExpandedCardShowsTokensAndCost() {
        val snapshot = StatsParser.parse(
            """{"periods":{"today":{"totalTokens":1200000,"costUsd":1.2}}}"""
        )
        val island = param(IslandPayload.json(snapshot, 3)!!)
        assertFalse(island.containsKey("progressInfo"))
        val base = island.getValue("baseInfo").jsonObject
        assertEquals(1, base.getValue("type").jsonPrimitive.int)
        assertEquals("1.2M", base.getValue("title").jsonPrimitive.content)
        assertEquals("$1.2000", base.getValue("content").jsonPrimitive.content)
    }

    private fun param(payload: String) = json.parseToJsonElement(payload).jsonObject.getValue("param_v2").jsonObject
}
