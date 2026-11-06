package com.javis.tokenmonitor.remote.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

// Wire shapes for the Node hub pairing API (tmp/lan-link-contract.md).

private val linkJson = Json { ignoreUnknownKeys = true }

/** Hub identity from `GET /api/link` or `POST /api/pair`. */
data class HubIdentity(
    val id: String,
    val name: String,
    val port: Int,
    val addresses: List<String>
)

/** Successful `/api/pair` response. The token is the only credential a phone stores. */
data class PairSuccess(
    val token: String,
    val hub: HubIdentity,
    val deviceId: String?,
    val deviceName: String?
)

/** `GET /api/link` payload for a device token. */
data class LinkStatus(
    val hub: HubIdentity,
    val role: String,
    val linkId: String?
)

sealed class PairOutcome {
    data class Paired(val token: String, val hub: HubIdentity) : PairOutcome()
    data class InvalidCode(val attemptsRemaining: Int?) : PairOutcome()
    data object Locked : PairOutcome()
    data object Inactive : PairOutcome()
    data object Expired : PairOutcome()
    data object BadRequest : PairOutcome()
    data object Unreachable : PairOutcome()
    data object Malformed : PairOutcome()
}

/** Request body for `POST /api/pair`; values are encoded by the JSON builder, never interpolated. */
fun pairRequestBody(code: String, deviceId: String, deviceName: String, platform: String = "android"): String =
    buildJsonObject {
        put("code", code)
        put("deviceId", deviceId)
        put("deviceName", deviceName)
        put("platform", platform)
    }.toString()

fun classifyPairResponse(status: Int, body: String): PairOutcome {
    val root = parseObject(body)
    if (status in 200..299) {
        val token = root?.get("token")?.jsonPrimitive?.contentOrNull.orEmpty()
        if (!token.startsWith(TOKEN_PREFIX)) return PairOutcome.Malformed
        val hub = root?.get("hub").asObject()?.toHubIdentity() ?: return PairOutcome.Malformed
        return PairOutcome.Paired(token, hub)
    }
    return when (status) {
        401 -> PairOutcome.InvalidCode(
            root?.get("attemptsRemaining").let { (it as? JsonPrimitive)?.intOrNull }
        )
        404 -> PairOutcome.Inactive
        410 -> PairOutcome.Expired
        429 -> PairOutcome.Locked
        400, 413 -> PairOutcome.BadRequest
        in 500..599 -> PairOutcome.Unreachable
        else -> PairOutcome.Malformed
    }
}

fun parsePairSuccess(status: Int, body: String): PairSuccess? {
    val outcome = classifyPairResponse(status, body) as? PairOutcome.Paired ?: return null
    val root = parseObject(body) ?: return null
    val device = root["device"].asObject()
    return PairSuccess(
        token = outcome.token,
        hub = outcome.hub,
        deviceId = device?.text("id")?.takeIf { it.isNotEmpty() },
        deviceName = device?.text("name")?.takeIf { it.isNotEmpty() }
    )
}

/** Returns null for non-2xx responses (older hubs return 404) and malformed bodies. */
fun parseLinkStatus(status: Int, body: String): LinkStatus? {
    if (status !in 200..299) return null
    val root = parseObject(body) ?: return null
    val hub = root["hub"].asObject()?.toHubIdentity() ?: return null
    val role = root.text("role")
    val link = root["link"].asObject()
    return LinkStatus(hub = hub, role = role, linkId = link?.text("id")?.takeIf { it.isNotEmpty() })
}

/** Serialized form of the persisted binding; the token is never part of this JSON. */
object HubLinkBindingJson {
    fun encode(binding: HubLinkBinding): String = buildJsonObject {
        put("v", 1)
        put("hubId", binding.hubId)
        put("hubName", binding.hubName)
        put("port", binding.port)
        put("pairedAt", binding.pairedAt)
        put(
            "candidates",
            buildJsonArray { binding.candidates.forEach { add(it) } }
        )
    }.toString()

    fun decode(raw: String?): HubLinkBinding? {
        if (raw.isNullOrBlank()) return null
        val root = parseObject(raw) ?: return null
        val hubId = normalizeHubId(root.text("hubId")) ?: return null
        val port = (root["port"] as? JsonPrimitive)?.intOrNull ?: return null
        if (port !in 1..65535) return null
        val hubName = cleanDisplayName(root.text("hubName")) ?: "Token Monitor"
        val candidates = (root["candidates"] as? JsonArray)
            .orEmpty()
            .mapNotNull { normalizeCandidate(it.textContent().orEmpty()) }
            .distinct()
            .take(MAX_LINK_CANDIDATES)
        return HubLinkBinding(
            hubId = hubId,
            hubName = hubName,
            port = port,
            candidates = candidates,
            pairedAt = root.text("pairedAt").trim()
        )
    }
}

/**
 * Exponential reconnect delay: 1 s, 2 s, 5 s, 10 s, 30 s, then 30 s forever. [reset] is called on
 * the first successful stats frame.
 */
class ReconnectBackoff(private val stepsMs: LongArray = DEFAULT_STEPS) {
    private var index = 0

    init {
        require(stepsMs.isNotEmpty()) { "backoff needs at least one step" }
    }

    fun nextDelayMs(): Long {
        val delay = stepsMs[index.coerceIn(0, stepsMs.lastIndex)]
        if (index < stepsMs.lastIndex) index += 1
        return delay
    }

    fun reset() {
        index = 0
    }

    companion object {
        val DEFAULT_STEPS = longArrayOf(1_000, 2_000, 5_000, 10_000, 30_000)
    }
}

private const val TOKEN_PREFIX = "tmk_"

private fun parseObject(body: String): JsonObject? = try {
    linkJson.parseToJsonElement(body) as? JsonObject
} catch (_: Exception) {
    null
}

private fun JsonElement?.textContent(): String? = (this as? JsonPrimitive)?.contentOrNull

private fun JsonObject.toHubIdentity(): HubIdentity? {
    val id = normalizeHubId(text("id")) ?: return null
    val name = cleanDisplayName(text("name")) ?: "Token Monitor"
    val port = (this["port"] as? JsonPrimitive)?.intOrNull ?: return null
    if (port !in 1..65535) return null
    val addresses = (this["addresses"] as? JsonArray)
        .orEmpty()
        .mapNotNull { element -> element.textContent()?.trim() }
        .filter { isIpv4(it) }
        .distinct()
        .take(4)
    return HubIdentity(id = id, name = name, port = port, addresses = addresses)
}
