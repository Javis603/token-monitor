package com.javis.tokenmonitor.remote.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import androidx.core.graphics.PathParser
import com.javis.tokenmonitor.remote.core.UNATTRIBUTED_ID
import kotlin.math.min

/**
 * Vendor marks copied from assets/icons. Files that depend on transforms or
 * masks are skipped; the row then shows the name only.
 */
internal class PosterMarks(private val context: Context) {
    private val cache = HashMap<String, Mark?>()

    fun draw(canvas: Canvas, file: String?, rect: RectF, ink: Int): Boolean {
        if (file.isNullOrEmpty()) return false
        val mark = load(file) ?: return false
        val scale = min(rect.width() / mark.width, rect.height() / mark.height)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        canvas.save()
        canvas.translate(
            rect.left + (rect.width() - mark.width * scale) / 2f,
            rect.top + (rect.height() - mark.height * scale) / 2f
        )
        canvas.scale(scale, scale)
        canvas.translate(-mark.minX, -mark.minY)
        for (part in mark.paths) {
            paint.color = inkColor(part.fill, ink)
            canvas.drawPath(part.path, paint)
        }
        canvas.restore()
        return true
    }

    fun toolFile(id: String): String? = if (id == UNATTRIBUTED_ID) null else ICON_FILE[id] ?: id

    fun modelFile(id: String): String? {
        val vendor = modelVendorFor(id) ?: return null
        return ICON_FILE[vendor] ?: vendor
    }

    private fun load(file: String): Mark? {
        if (cache.containsKey(file)) return cache[file]
        val mark = try {
            context.assets.open("marks/${file.lowercase()}.svg").bufferedReader().use { parse(it.readText()) }
        } catch (_: Exception) {
            null
        }
        cache[file] = mark
        return mark
    }

    private fun parse(svg: String): Mark? {
        if (svg.contains("transform=") || svg.contains("<mask")) return null
        val box = VIEW_BOX.find(svg)
        val minX = box?.groupValues?.get(1)?.toFloatOrNull() ?: 0f
        val minY = box?.groupValues?.get(2)?.toFloatOrNull() ?: 0f
        val width = box?.groupValues?.get(3)?.toFloatOrNull()?.takeIf { it > 0f } ?: return null
        val height = box?.groupValues?.get(4)?.toFloatOrNull()?.takeIf { it > 0f } ?: return null
        val svgEvenOdd = svg.contains("fill-rule=\"evenodd\"")
        val paths = PATH_TAG.findAll(svg).mapNotNull { match ->
            val attrs = match.groupValues[1]
            val data = ATTR.find(attrs)?.groupValues?.get(1) ?: return@mapNotNull null
            val path = try {
                PathParser.createPathFromPathData(spacePath(data))
            } catch (_: RuntimeException) {
                null
            } ?: return@mapNotNull null
            if (svgEvenOdd || attrs.contains("evenodd")) path.fillType = Path.FillType.EVEN_ODD
            MarkPath(path, parseFill(FILL.find(attrs)?.groupValues?.get(1)))
        }.toList()
        if (paths.isEmpty()) return null
        return Mark(minX, minY, width, height, paths)
    }

    private fun parseFill(raw: String?): Int? {
        if (raw == null || raw == "currentColor" || raw == "none") return null
        val hex = raw.removePrefix("#")
        val value = when (hex.length) {
            3 -> buildString { hex.forEach { append(it); append(it) } }.toLongOrNull(16)?.or(0xFF000000)
            6 -> hex.toLongOrNull(16)?.or(0xFF000000)
            8 -> hex.toLongOrNull(16)
            else -> null
        } ?: return null
        return value.toInt()
    }

    private fun inkColor(fill: Int?, ink: Int): Int {
        if (fill == null) return ink
        val red = (fill shr 16) and 0xFF
        val green = (fill shr 8) and 0xFF
        val blue = fill and 0xFF
        return if (red >= 236 && green >= 236 && blue >= 236) ink else fill
    }

    /**
     * PathParser rejects the compact form these marks use: `.797.797`, arc flags
     * written as `00`, and a flag glued to the next coordinate (`014.21`).
     * Arc flags are single 0/1 digits, so they are read before the following number.
     */
    private fun spacePath(data: String): String {
        val out = StringBuilder()
        var i = 0
        fun skipSep() {
            while (i < data.length && (data[i].isWhitespace() || data[i] == ',')) i++
        }
        fun readNumber(): String {
            skipSep()
            val start = i
            if (i < data.length && (data[i] == '+' || data[i] == '-')) i++
            var dotted = false
            var exponent = false
            while (i < data.length) {
                val ch = data[i]
                when {
                    ch.isDigit() -> i++
                    ch == '.' && !dotted && !exponent -> {
                        dotted = true
                        i++
                    }
                    (ch == 'e' || ch == 'E') && !exponent && i > start -> {
                        exponent = true
                        i++
                        if (i < data.length && (data[i] == '+' || data[i] == '-')) i++
                    }
                    else -> break
                }
            }
            if (i == start && i < data.length) i++
            return if (start < data.length) data.substring(start, i.coerceAtMost(data.length)) else ""
        }
        fun readFlag(): String {
            skipSep()
            if (i >= data.length) return "0"
            val flag = data[i]
            i++
            return flag.toString()
        }
        var command = ' '
        while (i < data.length) {
            skipSep()
            if (i >= data.length) break
            val cursor = data[i]
            if (cursor.isLetter()) {
                command = cursor
                out.append(cursor).append(' ')
                i++
                if (command == 'Z' || command == 'z') continue
            }
            if (command == 'A' || command == 'a') {
                val rx = readNumber()
                val ry = readNumber()
                val rotation = readNumber()
                val large = readFlag()
                val sweep = readFlag()
                val x = readNumber()
                val y = readNumber()
                out.append(rx).append(' ').append(ry).append(' ').append(rotation).append(' ')
                out.append(large).append(' ').append(sweep).append(' ').append(x).append(' ').append(y).append(' ')
            } else {
                val count = when (command) {
                    'H', 'h', 'V', 'v' -> 1
                    'S', 's', 'Q', 'q' -> 4
                    'C', 'c' -> 6
                    else -> 2
                }
                repeat(count) { out.append(readNumber()).append(' ') }
                if (command == 'M') command = 'L' else if (command == 'm') command = 'l'
            }
        }
        return out.toString()
    }

    private data class Mark(
        val minX: Float,
        val minY: Float,
        val width: Float,
        val height: Float,
        val paths: List<MarkPath>
    )

    private data class MarkPath(val path: Path, val fill: Int?)

    private companion object {
        val VIEW_BOX = Regex("""viewBox="\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)"""")
        val PATH_TAG = Regex("""<path\b([^>]*)/?>""")
        val ATTR = Regex("""\bd="([^"]*)"""")
        val FILL = Regex("""\bfill="([^"]*)"""")

        // mask || icon, where that file is not the id itself.
        // See ROW_ICON_MASKS in src/shared/vendorPresentation.js.
        val ICON_FILE = mapOf(
            "hermes" to "hermes-agent",
            "grok" to "xai",
            "mimo" to "xiaomi",
            "muse" to "meta",
            "zcode" to "zai",
            "mcode" to "minimax",
            "xai" to "grok",
            "zaiteam" to "zai",
            "museai" to "meta",
            "factory" to "droid"
        )
    }
}

/** Same rules as modelVendorFor in src/electron/renderer/usageCharts.js. */
internal fun modelVendorFor(model: String): String? {
    val name = model.lowercase()
    if (Regex("^(cursor-)?auto$").matches(name)) return "cursor"
    if (Regex("claude|anthropic|sonnet|opus|haiku").containsMatchIn(name)) return "claude"
    if (Regex("gpt|openai|codex|^o[134](?:-|\$)|o[134]-(mini|pro|preview)|chatgpt").containsMatchIn(name)) return "codex"
    if (Regex("gemini|gemma|google").containsMatchIn(name)) return "gemini"
    if (Regex("grok|xai").containsMatchIn(name)) return "xai"
    if (Regex("deepseek").containsMatchIn(name)) return "deepseek"
    if (Regex("nemotron|nvidia").containsMatchIn(name)) return "nvidia"
    if (Regex("llama|meta|(?:^|[^a-z0-9])muse-(?:spark|wonder|glimmer|image|voice)(?:-|\$)").containsMatchIn(name)) return "meta"
    if (Regex("mistral|mixtral|codestral").containsMatchIn(name)) return "mistral"
    if (Regex("qwen|qwq|qvq|qmodel").containsMatchIn(name)) return "qwen"
    if (Regex("kimi|moonshot|k2d6-agent|k3-agent|(?:^|[^a-z0-9])k[23](?:[^a-z0-9]|\$)").containsMatchIn(name)) return "kimi"
    if (Regex("chatglm|\\bglm-|\\bzai\\b|z\\.ai|zhipu").containsMatchIn(name)) return "zai"
    if (Regex("cohere|command-r").containsMatchIn(name)) return "cohere"
    if (Regex("mimo|xiaomi").containsMatchIn(name)) return "xiaomi"
    if (Regex("minimax|\\babab").containsMatchIn(name)) return "minimax"
    if (Regex("doubao|\\bseed(?:-|\$)").containsMatchIn(name)) return "doubao"
    if (Regex("stepfun|step-").containsMatchIn(name)) return "stepfun"
    if (Regex("hy\\d|hunyuan").containsMatchIn(name)) return "hunyuan"
    if (Regex("^swe[-_]|devin|cognition").containsMatchIn(name)) return "devin"
    if (Regex("^big-pickle\$").matches(name)) return "opencode"
    return null
}
