package com.javis.tokenmonitor.remote.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

internal fun JsonElement?.asObject(): JsonObject? = this as? JsonObject

internal fun JsonObject.child(name: String): JsonObject? = this[name].asObject()

internal fun JsonElement?.asLong(): Long {
    val primitive = this as? JsonPrimitive ?: return 0
    if (primitive.isString) return 0
    primitive.longOrNull?.let { return it }
    val asDouble = primitive.doubleOrNull ?: return 0
    return if (asDouble.isFinite()) asDouble.toLong() else 0
}

internal fun JsonElement?.asDoubleOrNull(): Double? {
    val primitive = this as? JsonPrimitive ?: return null
    if (primitive.isString) return null
    val value = primitive.doubleOrNull ?: return null
    return value.takeIf { it.isFinite() }
}

internal fun JsonElement?.asBooleanOrNull(): Boolean? {
    val primitive = this as? JsonPrimitive ?: return null
    return primitive.booleanOrNull
}

internal fun JsonElement?.asText(): String {
    val primitive = this as? JsonPrimitive ?: return ""
    return primitive.content
}

internal fun JsonObject.text(name: String): String = this[name].asText()

internal fun JsonElement?.asArray(): JsonArray? = this as? JsonArray
