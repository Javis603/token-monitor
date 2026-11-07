package com.javis.tokenmonitor.remote.core

import kotlinx.serialization.json.Json

object SnapshotJson {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun encode(snapshot: StatsSnapshot): String = json.encodeToString(snapshot)

    fun decode(raw: String): StatsSnapshot? = try {
        json.decodeFromString<StatsSnapshot>(raw)
    } catch (_: Exception) {
        null
    }
}
