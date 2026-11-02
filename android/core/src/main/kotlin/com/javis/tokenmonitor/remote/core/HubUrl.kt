package com.javis.tokenmonitor.remote.core

import java.net.URI
import java.net.URISyntaxException

fun normalizeHubUrl(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    val uri = try {
        URI(trimmed)
    } catch (_: URISyntaxException) {
        return null
    }
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    if (!uri.userInfo.isNullOrEmpty()) return null
    if (!uri.rawQuery.isNullOrEmpty() || uri.rawFragment != null) return null
    val authority = uri.authority?.takeIf { it.isNotBlank() } ?: return null
    if (uri.host.isNullOrBlank()) return null
    val path = uri.path.orEmpty().trimEnd('/')
    return "$scheme://$authority$path"
}
