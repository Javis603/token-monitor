package com.javis.tokenmonitor.remote.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.math.roundToInt

object IslandPayload {
    private val json = Json { prettyPrint = false }
    fun json(snapshot: StatsSnapshot, focusProtocol: Int): String? {
        if (focusProtocol != 2 && focusProtocol != 3) return null
        val tokens = Format.compactTokens(snapshot.today.totalTokens)
        val cost = Format.costUsd(snapshot.today.costUsd)
        val meter = snapshot.meteredWindows().firstOrNull()
        val root = buildJsonObject {
            put("param_v2", buildJsonObject {
                put("protocol", 1)
                put("business", "token_usage")
                put("updatable", true)
                put("reopen", "reopen")
                put("islandFirstFloat", false)
                put("enableFloat", false)
                put("filterWhenNoPermission", false)
                put("aodTitle", tokens)
                if (focusProtocol == 2) put("ticker", tokens)
                if (focusProtocol == 3) put("param_island", island(tokens))
                put("baseInfo", baseInfo(tokens, cost, meter))
                if (meter != null) {
                    put("progressInfo", buildJsonObject {
                        put("progress", meter.usedPercent.roundToInt().coerceIn(0, 100))
                        put("colorProgress", "#22C55E")
                        put("colorProgressEnd", "#22C55E")
                    })
                }
            })
        }
        return json.encodeToString(JsonElement.serializer(), root)
    }

    private fun island(tokens: String): JsonObject = buildJsonObject {
        put("islandProperty", 1)
        put("bigIslandArea", buildJsonObject {
            put("imageTextInfoLeft", buildJsonObject {
                put("type", 1)
                put("picInfo", buildJsonObject { put("type", 1) })
                put("textInfo", buildJsonObject {
                    put("title", tokens)
                    put("useHighLight", false)
                })
            })
        })
        put("smallIslandArea", buildJsonObject {
            put("picInfo", buildJsonObject { put("type", 1) })
        })
    }

    private fun baseInfo(tokens: String, cost: String, meter: MeteredWindow?): JsonObject {
        if (meter == null) {
            return buildJsonObject {
                put("type", 1)
                put("title", tokens)
                put("content", cost)
                put("colorTitle", "#22C55E")
            }
        }
        val title = listOf(meter.provider, meter.label)
            .filter { it.isNotBlank() }
            .joinToString(" ")
            .take(40)
        val percent = "${meter.usedPercent.roundToInt().coerceAtLeast(0)}%"
        return buildJsonObject {
            put("type", 2)
            put("title", title)
            put("content", percent)
            put("colorTitle", "#22C55E")
        }
    }
}
