package com.javis.tokenmonitor.remote.core

import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.util.Locale
import kotlin.math.abs

object Format {
    fun groupedTokens(value: Long): String = String.format(Locale.US, "%,d", value.coerceAtLeast(0))

    fun tokensForWidth(value: Long, fits: (String) -> Boolean): String {
        val grouped = groupedTokens(value)
        val compact = compactTokens(value)
        return if (grouped != compact && fits(grouped)) grouped else compact
    }

    fun compactTokens(value: Long): String {
        val n = value.coerceAtLeast(0).toDouble()
        return when {
            n >= 1_000_000_000 -> scaled(n / 1_000_000_000, "B")
            n >= 1_000_000 -> scaled(n / 1_000_000, "M")
            n >= 1_000 -> scaled(n / 1_000, "K")
            else -> value.coerceAtLeast(0).toString()
        }
    }

    fun costUsd(value: Double): String {
        if (!value.isFinite()) return "$0.00"
        val body = if (abs(value) >= 10) {
            String.format(Locale.US, "%.2f", value)
        } else {
            String.format(Locale.US, "%.4f", value)
        }
        return "$$body"
    }

    fun widgetCost(value: Double, fractionDigits: Int): String {
        if (!value.isFinite()) return if (fractionDigits <= 1) "$0.0" else "$0.00"
        val digits = fractionDigits.coerceIn(0, 2)
        val pattern = if (digits == 1) "#,##0.0" else "#,##0.00"
        val body = DecimalFormat(pattern, DecimalFormatSymbols.getInstance(Locale.US)).format(value)
        return "$$body"
    }

    fun amount(value: Double, currency: String?): String {
        if (!value.isFinite()) return "—"
        val body = if (abs(value) >= 10) {
            String.format(Locale.US, "%.2f", value)
        } else {
            String.format(Locale.US, "%.4f", value)
        }
        val code = currency?.trim().orEmpty()
        return if (code.isEmpty() || code.equals("USD", ignoreCase = true)) "$$body" else "$body $code"
    }

    private fun scaled(value: Double, suffix: String): String {
        val text = if (value >= 10) {
            String.format(Locale.US, "%.0f", value)
        } else {
            String.format(Locale.US, "%.1f", value)
        }
        val trimmed = if (text.endsWith(".0")) text.dropLast(2) else text
        return trimmed + suffix
    }
}
