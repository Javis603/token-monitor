package com.javis.tokenmonitor.remote.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

private val json = Json { ignoreUnknownKeys = true }

fun errorCode(body: String): String? = try {
    val root = json.parseToJsonElement(body) as? JsonObject ?: return null
    root["error"]?.jsonPrimitive?.contentOrNull
} catch (_: Exception) {
    null
}

fun classifyHealth(status: Int, body: String): HubFailure? {
    if (status in 200..299) return null
    if (status == 503 && errorCode(body) == "hub_stopping") return HubFailure.HubStopping
    return HubFailure.Unreachable
}

fun classifyStatsResponse(status: Int, body: String): HubOutcome {
    if (status == 401) return HubOutcome.Failure(HubFailure.Unauthorized)
    if (status == 503) {
        return when (errorCode(body)) {
            "secret_required" -> HubOutcome.Failure(HubFailure.SecretRequired)
            "hub_stopping" -> HubOutcome.Failure(HubFailure.HubStopping)
            else -> HubOutcome.Failure(HubFailure.Unreachable)
        }
    }
    if (status !in 200..299) return HubOutcome.Failure(HubFailure.Unreachable)
    return try {
        HubOutcome.Stats(StatsParser.parse(body))
    } catch (_: Exception) {
        HubOutcome.Failure(HubFailure.Malformed)
    }
}

fun classifySse(event: String, data: String): HubOutcome? {
    if (event != "snapshot" && event != "stats" && event != "freshness") return null
    val root = try {
        json.parseToJsonElement(data) as? JsonObject
    } catch (_: Exception) {
        return HubOutcome.Failure(HubFailure.Malformed)
    } ?: return HubOutcome.Failure(HubFailure.Malformed)
    val stats = root["stats"] ?: return HubOutcome.Failure(HubFailure.Malformed)
    return when (event) {
        "freshness" -> parseFreshness(stats)
        else -> try {
            HubOutcome.Stats(StatsParser.parseElement(stats))
        } catch (_: Exception) {
            HubOutcome.Failure(HubFailure.Malformed)
        }
    }
}

private fun parseFreshness(stats: kotlinx.serialization.json.JsonElement): HubOutcome {
    val node = stats.asObject() ?: return HubOutcome.Failure(HubFailure.Malformed)
    val devices = node["devices"].asArray().orEmpty().mapNotNull { element ->
        val device = element.asObject() ?: return@mapNotNull null
        val deviceId = device.text("deviceId")
        if (deviceId.isEmpty()) return@mapNotNull null
        DeviceFreshness(
            deviceId = deviceId,
            updatedAt = device.text("updatedAt").takeIf { it.isNotEmpty() },
            receivedAt = device.text("receivedAt").takeIf { it.isNotEmpty() },
            ageMs = device["ageMs"].asDoubleOrNull()?.toLong(),
            stale = device["stale"].asBooleanOrNull()
        )
    }
    val limitsUpdatedAt = node.child("limits")?.text("updatedAt")?.takeIf { it.isNotEmpty() }
    return HubOutcome.Freshness(
        FreshnessUpdate(
            updatedAt = node.text("updatedAt").takeIf { it.isNotEmpty() },
            staleAfterMs = node["staleAfterMs"].asDoubleOrNull()?.toLong(),
            limitsUpdatedAt = limitsUpdatedAt,
            devices = devices
        )
    )
}
