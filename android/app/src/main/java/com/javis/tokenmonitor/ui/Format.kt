package com.javis.tokenmonitor.ui

import android.text.format.DateUtils
import java.text.DateFormat
import java.util.Date
import java.time.Instant
import kotlin.math.abs

fun formatTokens(value: Double): String {
    val magnitude = abs(value)
    return when {
        magnitude >= 1_000_000_000 -> "%.2fB".format(value / 1_000_000_000)
        magnitude >= 1_000_000 -> "%.2fM".format(value / 1_000_000)
        magnitude >= 10_000 -> "%.0fK".format(value / 1_000)
        magnitude >= 1_000 -> "%.1fK".format(value / 1_000)
        else -> "%,.0f".format(value)
    }
}

/** Cost is absent on devices that could not price their usage; show that, not $0.00. */
fun formatCost(value: Double?): String = if (value == null) "—" else "$%.2f".format(value)

fun formatMoney(value: Double?, currency: String?): String = when {
    value == null -> "—"
    currency.isNullOrBlank() || currency.equals("USD", ignoreCase = true) -> "$%.2f".format(value)
    // Credits are not a currency, so no symbol is prepended to an amount of them.
    currency.equals("CREDITS", ignoreCase = true) -> "%.2f credits".format(value)
    else -> "%.2f %s".format(value, currency)
}

fun formatPercent(value: Double?): String = value?.let { "%.0f%%".format(it) } ?: "—"

/**
 * A relative timestamp in the device's own language ("3 分钟前", "just now").
 * The gateway sends a UTC instant; the "now" anchor is the phone, and the
 * phrasing belongs to whatever locale the user has chosen, not the gateway.
 */
fun formatRelative(iso: String?): String {
    if (iso.isNullOrBlank()) return "—"
    val then = runCatching { Instant.parse(iso) }.getOrNull() ?: return "—"
    return DateUtils.getRelativeTimeSpanString(
        then.toEpochMilli(),
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS
    ).toString()
}

/** A reset moment formatted for the user's locale, e.g. "8月28日 14:00". */
fun formatReset(iso: String?): String {
    if (iso.isNullOrBlank()) return ""
    val instant = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    return DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT)
        .format(Date.from(instant))
}

/** Tool and model ids arrive lower-cased and hyphenated; this is display only. */
fun formatLabel(raw: String): String = raw
    .trim()
    .replace(Regex("[-_]+"), " ")
    .split(" ")
    .filter { it.isNotEmpty() }
    .joinToString(" ") { it.replaceFirstChar { char -> char.uppercaseChar() } }
