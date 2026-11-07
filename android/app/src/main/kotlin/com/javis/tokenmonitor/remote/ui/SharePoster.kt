package com.javis.tokenmonitor.remote.ui

import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.widget.Toast
import android.text.TextPaint
import android.text.TextUtils
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import com.javis.tokenmonitor.remote.R
import com.javis.tokenmonitor.remote.core.Format
import com.javis.tokenmonitor.remote.core.ShareCard
import com.javis.tokenmonitor.remote.core.ShareHeat
import com.javis.tokenmonitor.remote.core.ShareMark
import com.javis.tokenmonitor.remote.core.ShareRank
import com.javis.tokenmonitor.remote.core.UNATTRIBUTED_ID
import java.io.File
import kotlin.math.min

private const val POSTER_WIDTH = 1080
private const val POSTER_HEIGHT = 1350
private const val INK = 0xFF1C1F26.toInt()
private const val MUTED = 0xFF5B626D.toInt()
private const val ACCENT = 0xFF2F8AE6.toInt()
private const val ACCENT_DEEP = 0xFF1F74E8.toInt()
private const val TRACK = 0xFFE5F3FC.toInt()
private const val COST = 0xFF15A35E.toInt()
private const val LINE = 0xFF22C07A.toInt()
private const val INSET = 84f

internal fun appIcon(context: android.content.Context): Bitmap {
    val raw = BitmapFactory.decodeResource(context.resources, R.drawable.ic_launcher_foreground)
    val bounds = opaqueBounds(raw)
    val cropped = Bitmap.createBitmap(raw, bounds.left, bounds.top, bounds.width(), bounds.height())
    if (cropped != raw) raw.recycle()
    return cropped
}

private fun opaqueBounds(bitmap: Bitmap): android.graphics.Rect {
    val width = bitmap.width
    val height = bitmap.height
    var minX = width
    var minY = height
    var maxX = -1
    var maxY = -1
    val pixels = IntArray(width)
    for (y in 0 until height) {
        bitmap.getPixels(pixels, 0, width, 0, y, width, 1)
        for (x in 0 until width) {
            if (pixels[x] ushr 24 > 16) {
                if (x < minX) minX = x
                if (x > maxX) maxX = x
                if (y < minY) minY = y
                if (y > maxY) maxY = y
            }
        }
    }
    return if (maxX < minX) android.graphics.Rect(0, 0, width, height) else android.graphics.Rect(minX, minY, maxX + 1, maxY + 1)
}

internal fun renderSharePoster(
    icon: Bitmap,
    marks: PosterMarks,
    card: ShareCard,
    brand: String,
    period: String,
    titles: PosterTitles,
    nameOf: (String) -> String,
    markOf: (String) -> String?
): Bitmap {
    val bitmap = Bitmap.createBitmap(POSTER_WIDTH, POSTER_HEIGHT, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    drawBackdrop(canvas)
    drawMasthead(canvas, icon, brand, period)
    when (card) {
        is ShareCard.Tokens -> drawTokens(canvas, card, titles)
        is ShareCard.Cost -> drawCost(canvas, card, titles)
        is ShareCard.Models -> drawModels(canvas, marks, card.rows, titles.models, nameOf, markOf)
        is ShareCard.Tools -> drawTools(canvas, marks, card.rows, titles.tools, nameOf, markOf)
        is ShareCard.Trend -> drawTrend(canvas, card, titles.trend)
    }
    return bitmap
}

internal data class PosterTitles(
    val usage: String,
    val spend: String,
    val models: String,
    val tools: String,
    val trend: String,
    val unit: String,
    val versus: String
)

private fun drawBackdrop(canvas: Canvas) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(
        0f,
        0f,
        0f,
        POSTER_HEIGHT.toFloat(),
        intArrayOf(0xFFF4FAFF.toInt(), 0xFFFFFFFF.toInt(), 0xFFF2FBF7.toInt()),
        floatArrayOf(0f, 0.42f, 1f),
        Shader.TileMode.CLAMP
    )
    canvas.drawRect(0f, 0f, POSTER_WIDTH.toFloat(), POSTER_HEIGHT.toFloat(), paint)
    paint.shader = RadialGradient(960f, 20f, 560f, 0xA8C4E6FF.toInt(), 0x00C4E6FF, Shader.TileMode.CLAMP)
    canvas.drawCircle(960f, 20f, 560f, paint)
    paint.shader = RadialGradient(80f, 1280f, 520f, 0xA8C6F6E0.toInt(), 0x00C6F6E0, Shader.TileMode.CLAMP)
    canvas.drawCircle(80f, 1280f, 520f, paint)
}


private fun drawMasthead(canvas: Canvas, icon: Bitmap, brand: String, period: String) {
    val logo = 86f
    val top = 72f
    drawIcon(canvas, icon, RectF(INSET, top, INSET + logo, top + logo), 255)
    val name = textPaint(44f, INK, Typeface.SANS_SERIF, Paint.Align.LEFT, true)
    val baseline = top + logo / 2f - (name.ascent() + name.descent()) / 2f
    canvas.drawText(brand, INSET + logo + 22f, baseline, name)
    canvas.drawText(period, POSTER_WIDTH - INSET, baseline, textPaint(36f, MUTED, Typeface.SANS_SERIF, Paint.Align.RIGHT, false))
}

private fun drawTokens(canvas: Canvas, card: ShareCard.Tokens, titles: PosterTitles) {
    val title = textPaint(72f, ACCENT, Typeface.SANS_SERIF, Paint.Align.LEFT, true)
    canvas.drawText(titles.usage, INSET, 300f, title)
    drawSparkle(canvas, INSET + title.measureText(titles.usage) + 36f, 268f, 14f, ACCENT)
    val number = Format.groupedTokens(card.tokens)
    val size = fittedSize(number, POSTER_WIDTH - INSET * 2, 108f, 64f)
    val hero = textPaint(size, INK, Typeface.MONOSPACE, Paint.Align.LEFT, true)
    val baseline = 470f
    canvas.drawText(number, INSET, baseline, hero)
    val rule = Paint(Paint.ANTI_ALIAS_FLAG)
    rule.color = ACCENT
    canvas.drawRoundRect(RectF(INSET, baseline + 22f, INSET + min(260f, hero.measureText(number) * 0.34f), baseline + 34f), 6f, 6f, rule)
    canvas.drawText(titles.unit, INSET, baseline + 96f, textPaint(40f, MUTED, Typeface.SANS_SERIF, Paint.Align.LEFT, false))
    card.change?.let { drawChange(canvas, it, titles.versus, INSET, baseline + 176f) }
    if (card.bars.any { it.tokens > 0L }) {
        val area = RectF(INSET, 860f, POSTER_WIDTH - INSET, 1160f)
        drawColumns(canvas, card.bars, area, pill = true)
        drawAxis(canvas, card.bars, card.axisStart, card.axisEnd, area, 1236f)
    }
}

private fun drawCost(canvas: Canvas, card: ShareCard.Cost, titles: PosterTitles) {
    val title = textPaint(72f, COST, Typeface.SANS_SERIF, Paint.Align.LEFT, true)
    canvas.drawText(titles.spend, INSET, 300f, title)
    val amount = Format.costUsd(card.costUsd)
    val size = fittedSize(amount, POSTER_WIDTH - INSET * 2, 132f, 72f)
    canvas.drawText(amount, INSET, 500f, textPaint(size, COST, Typeface.MONOSPACE, Paint.Align.LEFT, true))
    card.change?.let { drawChange(canvas, it, titles.versus, INSET, 620f) }
    if (card.series.count { it > 0.0 } >= 2) {
        drawSparkline(canvas, card.series, RectF(INSET, 760f, POSTER_WIDTH - 300f, 1060f))
        drawEnds(canvas, card.start, card.end, 1188f)
    }
    drawBill(canvas, POSTER_WIDTH - 190f, 980f)
}

private fun drawModels(
    canvas: Canvas,
    marks: PosterMarks,
    rows: List<ShareRank>,
    title: String,
    nameOf: (String) -> String,
    markOf: (String) -> String?
) {
    canvas.drawText(title, INSET, 280f, textPaint(72f, ACCENT, Typeface.SANS_SERIF, Paint.Align.LEFT, true))
    if (rows.isEmpty()) return
    val card = RectF(64f, 340f, POSTER_WIDTH - 64f, 660f)
    drawPlate(canvas, card, 56f)
    drawRankLine(canvas, marks, rows.first(), card.left + 40f, card.top + 64f, card.right - 40f, emphasize = true, nameOf, markOf, bar = 20f)
    rows.drop(1).forEachIndexed { index, row ->
        drawRankLine(canvas, marks, row, INSET, 720f + index * 240f, POSTER_WIDTH - INSET, emphasize = false, nameOf, markOf, bar = 14f)
    }
}

private fun drawTools(
    canvas: Canvas,
    marks: PosterMarks,
    rows: List<ShareRank>,
    title: String,
    nameOf: (String) -> String,
    markOf: (String) -> String?
) {
    canvas.drawText(title, INSET, 280f, textPaint(72f, INK, Typeface.SANS_SERIF, Paint.Align.LEFT, true))
    if (rows.isEmpty()) return
    val card = RectF(64f, 340f, POSTER_WIDTH - 64f, 700f)
    drawPlate(canvas, card, 56f)
    drawRankLine(canvas, marks, rows.first(), card.left + 40f, card.top + 64f, card.right - 40f, emphasize = true, nameOf, markOf, bar = 22f)
    rows.drop(1).forEachIndexed { index, row ->
        drawRankLine(canvas, marks, row, INSET, 760f + index * 220f, POSTER_WIDTH - INSET, emphasize = false, nameOf, markOf, bar = 12f)
    }
}

private fun drawTrend(canvas: Canvas, card: ShareCard.Trend, title: String) {
    canvas.drawText(title, INSET, 320f, textPaint(80f, ACCENT, Typeface.SANS_SERIF, Paint.Align.LEFT, true))
    val heat = card.heat
    val peak = heat?.cells?.maxOfOrNull { it.tokens } ?: card.bars.maxOfOrNull { it.tokens } ?: 0L
    val total = Format.compactTokens(peak)
    val size = fittedSize(total, POSTER_WIDTH * 0.42f, 92f, 56f)
    canvas.drawText(total, POSTER_WIDTH - INSET, 320f, textPaint(size, INK, Typeface.MONOSPACE, Paint.Align.RIGHT, true))
    if (heat != null) {
        drawHeat(canvas, heat, RectF(48f, 400f, POSTER_WIDTH - 48f, 1260f))
        return
    }
    if (card.bars.isEmpty()) return
    val area = RectF(INSET, 460f, POSTER_WIDTH - INSET, 1140f)
    drawColumns(canvas, card.bars, area, pill = false)
    drawAxis(canvas, card.bars, card.axisStart, card.axisEnd, area, 1224f)
}

private fun drawHeat(canvas: Canvas, heat: ShareHeat, area: RectF) {
    if (heat.weeks <= 0 || heat.cells.isEmpty()) return
    val weeks = heat.weeks
    val rows = 7
    val gap = 6f
    val labelSpace = 44f
    val cell = min(
        (area.width() - gap * (weeks - 1)) / weeks,
        (area.height() - labelSpace - gap * (rows - 1)) / rows
    ).coerceAtLeast(6f)
    val gridWidth = weeks * cell + (weeks - 1) * gap
    val gridHeight = rows * cell + (rows - 1) * gap
    val left = area.left + (area.width() - gridWidth) / 2f
    val top = area.top + (area.height() - labelSpace - gridHeight) / 2f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    val radius = cell * 0.22f
    for (item in heat.cells) {
        val x = left + item.column * (cell + gap)
        val y = top + item.row * (cell + gap)
        paint.color = heatFill(item.level, item.mark)
        canvas.drawRoundRect(RectF(x, y, x + cell, y + cell), radius, radius, paint)
    }
    val text = textPaint(22f, MUTED, Typeface.SANS_SERIF, Paint.Align.LEFT, false)
    var lastRight = -1000f
    val baseline = top + gridHeight + text.textSize + 10f
    for (month in heat.months) {
        val x = left + month.column * (cell + gap)
        val width = text.measureText(month.label)
        if (x < lastRight + 6f) continue
        canvas.drawText(month.label, x, baseline, text)
        lastRight = x + width
    }
}

private fun heatFill(level: Int, mark: ShareMark): Int {
    if (level <= 0 && mark != ShareMark.Today) return 0xFFEEF3F8.toInt()
    val index = level.coerceIn(0, 4)
    val history = intArrayOf(0xFFEEF3F8.toInt(), 0xFFC5E6FF.toInt(), 0xFF7EBEFF.toInt(), 0xFF3B93F5.toInt(), 0xFF1F74E8.toInt())
    val month = intArrayOf(0xFFEEF3F8.toInt(), 0xFFB7E7CC.toInt(), 0xFF5ED49A.toInt(), 0xFF22B573.toInt(), 0xFF0E9A5C.toInt())
    return when (mark) {
        ShareMark.Today -> 0xFFFF6A1A.toInt()
        ShareMark.Month -> month[index]
        ShareMark.None -> history[index]
    }
}

private fun drawRankLine(
    canvas: Canvas,
    marks: PosterMarks,
    row: ShareRank,
    left: Float,
    top: Float,
    right: Float,
    emphasize: Boolean,
    nameOf: (String) -> String,
    markOf: (String) -> String?,
    bar: Float = 16f
) {
    val mark = if (emphasize) 92f else 72f
    val logo = RectF(left, top + 16f, left + mark, top + 16f + mark)
    marks.draw(canvas, markOf(row.id), logo, INK)
    val textLeft = left + mark + 28f
    val value = Format.compactTokens(row.tokens)
    val valuePaint = textPaint(if (emphasize) 52f else 40f, if (emphasize) ACCENT else MUTED, Typeface.MONOSPACE, Paint.Align.RIGHT, true)
    val namePaint = textPaint(if (emphasize) 46f else 40f, INK, Typeface.SANS_SERIF, Paint.Align.LEFT, true)
    val crownRoom = if (emphasize) 52f else 0f
    val name = TextUtils.ellipsize(nameOf(row.id), namePaint, right - textLeft - valuePaint.measureText(value) - 24f - crownRoom, TextUtils.TruncateAt.END).toString()
    val nameBaseline = top + if (emphasize) 58f else 48f
    canvas.drawText(name, textLeft, nameBaseline, namePaint)
    if (emphasize) {
        drawEmoji(canvas, "👑", textLeft + namePaint.measureText(name) + 20f, nameBaseline + namePaint.ascent(), 44f, 22f)
    }
    canvas.drawText(value, right, nameBaseline, valuePaint)
    val barTop = nameBaseline + 28f
    drawShareBar(canvas, RectF(textLeft, barTop, right, barTop + bar), row.fraction)
}

private data class BarLayout(val slot: Float, val gap: Float, val left: Float)

private fun barLayout(count: Int, area: RectF): BarLayout {
    val gap = if (count > 8) 16f else 24f
    val natural = (area.width() - gap * (count - 1)) / count
    val slot = if (count > 8) natural else natural.coerceAtMost(96f)
    val group = count * slot + gap * (count - 1)
    return BarLayout(slot, gap, area.left + (area.width() - group) / 2f)
}

private fun drawAxis(
    canvas: Canvas,
    bars: List<com.javis.tokenmonitor.remote.core.ShareBar>,
    axisStart: String,
    axisEnd: String,
    area: RectF,
    y: Float
) {
    if (bars.size > 8) {
        drawEnds(canvas, axisStart.ifEmpty { bars.first().label }, axisEnd.ifEmpty { bars.last().label }, y)
        return
    }
    val layout = barLayout(bars.size, area)
    var left = layout.left
    val paint = textPaint(22f, MUTED, Typeface.SANS_SERIF, Paint.Align.CENTER, false)
    bars.forEach { bar ->
        val parts = bar.label.split("–")
        val center = left + layout.slot / 2f
        if (parts.size == 2) {
            canvas.drawText(parts[0], center, y, paint)
            canvas.drawText(parts[1], center, y + 28f, paint)
        } else {
            paint.textSize = 22f
            while (paint.textSize > 16f && paint.measureText(bar.label) > layout.slot + 8f) paint.textSize -= 1f
            canvas.drawText(bar.label, center, y, paint)
            paint.textSize = 22f
        }
        left += layout.slot + layout.gap
    }
}

private fun drawColumns(canvas: Canvas, bars: List<com.javis.tokenmonitor.remote.core.ShareBar>, area: RectF, pill: Boolean) {
    if (bars.isEmpty()) return
    val layout = barLayout(bars.size, area)
    val slot = layout.slot
    var left = layout.left
    val peak = bars.maxOf { it.tokens }.coerceAtLeast(1L)
    val peakIndex = bars.indices.maxBy { bars[it].tokens }
    var peakCenter = left
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    bars.forEachIndexed { index, bar ->
        if (bar.tokens > 0L) {
            val height = (area.height() * bar.tokens / peak.toFloat()).coerceAtLeast(min(slot, 48f))
            val rect = RectF(left, area.bottom - height, left + slot, area.bottom)
            val hot = pill && index == peakIndex
            val path = columnPath(rect)
            if (hot) {
                val glow = Paint(Paint.ANTI_ALIAS_FLAG)
                glow.color = 0x66FF7A2A
                glow.maskFilter = BlurMaskFilter(16f, BlurMaskFilter.Blur.NORMAL)
                canvas.drawPath(path, glow)
            }
            paint.shader = LinearGradient(
                rect.left,
                rect.top,
                rect.left,
                rect.bottom,
                when {
                    hot -> 0xFFFFC14D.toInt()
                    index == peakIndex -> 0xFF8ED0FF.toInt()
                    else -> 0xFFC4E7FF.toInt()
                },
                when {
                    hot -> 0xFFFF5C1A.toInt()
                    index == peakIndex -> ACCENT_DEEP
                    else -> 0xFF7EBEFF.toInt()
                },
                Shader.TileMode.CLAMP
            )
            canvas.drawPath(path, paint)
            paint.shader = null
        }
        if (index == peakIndex) peakCenter = left + slot / 2f
        left += slot + layout.gap
    }
    if (!pill || bars[peakIndex].tokens <= 0L) return
    val value = Format.compactTokens(bars[peakIndex].tokens)
    val text = textPaint(28f, 0xFFFFFFFF.toInt(), Typeface.SANS_SERIF, Paint.Align.LEFT, true)
    val emoji = 34f
    val width = emoji + text.measureText(value) + 48f
    val height = 58f
    val center = peakCenter.coerceIn(area.left + width / 2f, area.right - width / 2f)
    val rect = RectF(center - width / 2f, area.top - height - 12f, center + width / 2f, area.top - 12f)
    paint.setShadowLayer(16f, 0f, 6f, 0x66FF6A1A)
    paint.color = 0xFFFF6A1A.toInt()
    canvas.drawRoundRect(rect, height / 2f, height / 2f, paint)
    paint.clearShadowLayer()
    drawEmoji(canvas, "🔥", rect.left + 16f + emoji / 2f, rect.centerY(), emoji, 0f)
    canvas.drawText(value, rect.left + 24f + emoji, rect.centerY() - (text.ascent() + text.descent()) / 2f, text)
}

private fun columnPath(rect: RectF): Path {
    val radius = rect.width() / 2f
    val path = Path()
    if (rect.height() <= rect.width()) {
        path.addRoundRect(rect, radius, radius, Path.Direction.CW)
        return path
    }
    path.moveTo(rect.left, rect.bottom)
    path.lineTo(rect.left, rect.top + radius)
    path.arcTo(RectF(rect.left, rect.top, rect.right, rect.top + rect.width()), 180f, 180f, false)
    path.lineTo(rect.right, rect.bottom)
    path.close()
    return path
}

private fun drawSparkline(canvas: Canvas, values: List<Double>, area: RectF) {
    if (values.size < 2) return
    val max = values.max()
    val minValue = values.min()
    val span = (max - minValue).takeIf { it > 0.0 } ?: return
    val pad = area.height() * 0.14f
    val points = values.mapIndexed { index, value ->
        val x = area.left + area.width() * index / values.lastIndex
        val y = area.top + pad + (area.height() - pad * 2f) * (1f - ((value - minValue) / span).toFloat())
        x to y
    }
    val curve = smoothCurve(points)
    val fill = Path(curve)
    fill.lineTo(points.last().first, area.bottom)
    fill.lineTo(points.first().first, area.bottom)
    fill.close()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.shader = LinearGradient(0f, area.top, 0f, area.bottom, 0x7334E0A0, 0x0034E0A0, Shader.TileMode.CLAMP)
    canvas.drawPath(fill, paint)
    paint.shader = null
    paint.style = Paint.Style.STROKE
    paint.strokeCap = Paint.Cap.ROUND
    paint.strokeJoin = Paint.Join.ROUND
    paint.strokeWidth = 20f
    paint.color = 0x4020C97A
    canvas.drawPath(curve, paint)
    paint.strokeWidth = 8f
    paint.color = LINE
    canvas.drawPath(curve, paint)
    val end = points.last()
    paint.style = Paint.Style.FILL
    paint.color = 0xFFFFFFFF.toInt()
    canvas.drawCircle(end.first, end.second, 11f, paint)
    paint.color = LINE
    canvas.drawCircle(end.first, end.second, 6f, paint)
}

private fun smoothCurve(points: List<Pair<Float, Float>>): Path {
    val path = Path()
    if (points.isEmpty()) return path
    path.moveTo(points.first().first, points.first().second)
    if (points.size < 3) {
        if (points.size == 2) path.lineTo(points[1].first, points[1].second)
        return path
    }
    for (index in 0 until points.lastIndex) {
        val previous = points[(index - 1).coerceAtLeast(0)]
        val current = points[index]
        val next = points[index + 1]
        val after = points[(index + 2).coerceAtMost(points.lastIndex)]
        path.cubicTo(
            current.first + (next.first - previous.first) / 6f,
            current.second + (next.second - previous.second) / 6f,
            next.first - (after.first - current.first) / 6f,
            next.second - (after.second - current.second) / 6f,
            next.first,
            next.second
        )
    }
    return path
}

private fun drawEnds(canvas: Canvas, start: String, end: String, y: Float) {
    if (start.isEmpty() && end.isEmpty()) return
    canvas.drawText(start, INSET, y, textPaint(28f, MUTED, Typeface.SANS_SERIF, Paint.Align.LEFT, false))
    canvas.drawText(end, POSTER_WIDTH - INSET, y, textPaint(28f, MUTED, Typeface.SANS_SERIF, Paint.Align.RIGHT, false))
}

private fun drawChange(canvas: Canvas, change: Float, label: String, x: Float, baseline: Float) {
    val up = change >= 0f
    val color = if (up) COST else 0xFFE04560.toInt()
    val body = "${if (up) "↑" else "↓"} ${String.format(java.util.Locale.US, "%+.1f%%", change * 100f)}"
    val value = textPaint(32f, color, Typeface.SANS_SERIF, Paint.Align.LEFT, true)
    val width = value.measureText(body) + 40f
    val plate = Paint(Paint.ANTI_ALIAS_FLAG)
    plate.color = if (up) 0xFFD9F8EA.toInt() else 0xFFFFE4EA.toInt()
    canvas.drawRoundRect(RectF(x, baseline - 46f, x + width, baseline + 16f), 28f, 28f, plate)
    canvas.drawText(body, x + 20f, baseline, value)
    canvas.drawText(label, x + width + 18f, baseline, textPaint(32f, MUTED, Typeface.SANS_SERIF, Paint.Align.LEFT, false))
}

private fun drawSparkle(canvas: Canvas, cx: Float, cy: Float, radius: Float, color: Int) {
    val path = Path()
    path.moveTo(cx, cy - radius)
    path.quadTo(cx + radius * 0.22f, cy - radius * 0.22f, cx + radius, cy)
    path.quadTo(cx + radius * 0.22f, cy + radius * 0.22f, cx, cy + radius)
    path.quadTo(cx - radius * 0.22f, cy + radius * 0.22f, cx - radius, cy)
    path.quadTo(cx - radius * 0.22f, cy - radius * 0.22f, cx, cy - radius)
    path.close()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.color = color
    canvas.drawPath(path, paint)
}

private fun drawPlate(canvas: Canvas, rect: RectF, radius: Float) {
    val shadow = Paint(Paint.ANTI_ALIAS_FLAG)
    shadow.color = 0x3367B4F0
    shadow.maskFilter = BlurMaskFilter(28f, BlurMaskFilter.Blur.NORMAL)
    canvas.drawRoundRect(RectF(rect.left + 10f, rect.top + 18f, rect.right - 10f, rect.bottom + 8f), radius, radius, shadow)
    val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    fill.shader = LinearGradient(
        rect.left,
        rect.top,
        rect.left,
        rect.bottom,
        0xFFFFFFFF.toInt(),
        0xFFF5FAFF.toInt(),
        Shader.TileMode.CLAMP
    )
    canvas.drawRoundRect(rect, radius, radius, fill)
    val edge = Paint(Paint.ANTI_ALIAS_FLAG)
    edge.style = Paint.Style.STROKE
    edge.strokeWidth = 2f
    edge.color = 0xF2FFFFFF.toInt()
    canvas.drawRoundRect(rect, radius, radius, edge)
}

private fun drawEmoji(canvas: Canvas, emoji: String, cx: Float, cy: Float, size: Float, degrees: Float) {
    val paint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = size
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT
    }
    canvas.save()
    canvas.rotate(degrees, cx, cy)
    canvas.drawText(emoji, cx, cy - (paint.ascent() + paint.descent()) / 2f, paint)
    canvas.restore()
}

private fun drawBill(canvas: Canvas, cx: Float, cy: Float) {
    canvas.save()
    canvas.translate(cx, cy)
    canvas.rotate(16f)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.color = 0x4020C97A
    paint.maskFilter = BlurMaskFilter(20f, BlurMaskFilter.Blur.NORMAL)
    canvas.drawRoundRect(RectF(-102f, -46f, 102f, 62f), 20f, 20f, paint)
    paint.maskFilter = null
    paint.shader = LinearGradient(-96f, -52f, 96f, 52f, 0xFFC8F6DE.toInt(), 0xFF3DCF8C.toInt(), Shader.TileMode.CLAMP)
    canvas.drawRoundRect(RectF(-96f, -52f, 96f, 52f), 20f, 20f, paint)
    paint.shader = null
    paint.style = Paint.Style.STROKE
    paint.strokeWidth = 3f
    paint.color = 0xE6FFFFFF.toInt()
    canvas.drawRoundRect(RectF(-74f, -32f, 74f, 32f), 14f, 14f, paint)
    paint.style = Paint.Style.FILL
    paint.color = 0xFFFFFFFF.toInt()
    canvas.drawCircle(0f, 0f, 20f, paint)
    val mark = textPaint(28f, COST, Typeface.SANS_SERIF, Paint.Align.CENTER, true)
    canvas.drawText("$", 0f, -(mark.ascent() + mark.descent()) / 2f, mark)
    canvas.restore()
}

private fun drawShareBar(canvas: Canvas, rect: RectF, fraction: Float) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    val radius = rect.height() / 2f
    paint.color = TRACK
    canvas.drawRoundRect(rect, radius, radius, paint)
    val fill = rect.left + rect.width() * fraction.coerceIn(0f, 1f)
    if (fill <= rect.left + 1f) return
    val filled = RectF(rect.left, rect.top, fill, rect.bottom)
    paint.shader = LinearGradient(filled.left, filled.top, filled.right, filled.top, 0xFF8ED0FF.toInt(), ACCENT_DEEP, Shader.TileMode.CLAMP)
    canvas.drawRoundRect(filled, radius, radius, paint)
}

private fun drawIcon(canvas: Canvas, icon: Bitmap, rect: RectF, alpha: Int) {
    val paint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    paint.alpha = alpha
    canvas.drawBitmap(icon, null, rect, paint)
}

private fun textPaint(size: Float, color: Int, family: Typeface, align: Paint.Align, bold: Boolean): TextPaint {
    return TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        textSize = size
        typeface = Typeface.create(family, if (bold) Typeface.BOLD else Typeface.NORMAL)
        textAlign = align
    }
}

private fun fittedSize(text: String, maxWidth: Float, maxSize: Float, minSize: Float, family: Typeface = Typeface.MONOSPACE): Float {
    val paint = textPaint(maxSize, INK, family, Paint.Align.LEFT, bold = true)
    var size = maxSize
    while (size > minSize && paint.measureText(text) > maxWidth) {
        size -= 2f
        paint.textSize = size
    }
    while (size > 48f && paint.measureText(text) > maxWidth) {
        size -= 2f
        paint.textSize = size
    }
    return size
}

@Composable
fun ShareSheet(cards: List<ShareCard>, periodLabel: String, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    val marks = remember(context) { PosterMarks(context) }
    val icon = remember(context) { appIcon(context) }
    val brand = stringResource(R.string.poster_brand)
    val usage = stringResource(R.string.poster_kind_tokens)
    val spend = stringResource(R.string.poster_kind_cost)
    val modelsTitle = stringResource(R.string.poster_kind_models)
    val toolsTitle = stringResource(R.string.poster_kind_tools)
    val trendTitle = stringResource(R.string.poster_kind_trend)
    val unattributed = stringResource(R.string.unattributed)
    val unit = stringResource(R.string.poster_unit)
    val versus = stringResource(R.string.poster_versus)
    val titles = PosterTitles(usage, spend, modelsTitle, toolsTitle, trendTitle, unit, versus)
    val bitmaps = remember(cards, brand, periodLabel, titles, unattributed, icon) {
        cards.map { card ->
            renderSharePoster(icon, marks, card, brand, periodLabel, titles, { id ->
                when {
                    id == UNATTRIBUTED_ID -> unattributed
                    card is ShareCard.Tools -> providerName(id)
                    else -> id
                }
            }) { id ->
                when {
                    id == UNATTRIBUTED_ID -> null
                    card is ShareCard.Tools -> marks.toolFile(id)
                    card is ShareCard.Models -> marks.modelFile(id)
                    else -> null
                }
            }
        }
    }
    DisposableEffect(bitmaps) {
        onDispose { bitmaps.forEach { if (!it.isRecycled) it.recycle() } }
    }
    val pager = rememberPagerState { bitmaps.size }
    var pendingPage by remember { mutableIntStateOf(0) }
    val createDocument = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("image/png")) { uri ->
        val bitmap = bitmaps.getOrNull(pendingPage)
        val saved = uri != null && bitmap != null && context.contentResolver.openOutputStream(uri)?.use { stream ->
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        } == true
        if (uri != null) {
            if (saved) haptic.performHapticFeedback(HapticFeedbackType.Confirm)
            Toast.makeText(context, if (saved) R.string.poster_saved else R.string.poster_save_failed, Toast.LENGTH_SHORT).show()
        }
    }
    LaunchedEffect(bitmaps.size) {
        if (pager.currentPage > bitmaps.lastIndex) pager.scrollToPage(0)
    }
    Box(
        Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.42f))
    ) {
        Column(
            Modifier
                .fillMaxSize()
                .statusBarsPadding()
                .navigationBarsPadding()
                .padding(top = 12.dp, bottom = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), horizontalArrangement = Arrangement.End) {
                GlassIconButton(R.drawable.ic_close, stringResource(R.string.close), onDismiss)
            }
            HorizontalPager(
                state = pager,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 36.dp),
                pageSpacing = 16.dp
            ) { page ->
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Image(
                        bitmap = bitmaps[page].asImageBitmap(),
                        contentDescription = kindLabel(cards[page]),
                        modifier = Modifier
                            .fillMaxWidth()
                            .aspectRatio(POSTER_WIDTH / POSTER_HEIGHT.toFloat())
                            .clip(RoundedCornerShape(28.dp)),
                        contentScale = ContentScale.FillBounds
                    )
                }
            }
            Text(
                kindLabel(cards[pager.currentPage.coerceIn(0, cards.lastIndex)]),
                modifier = Modifier.padding(top = 16.dp, bottom = 18.dp),
                color = Color.White,
                style = MaterialTheme.typography.headlineSmall.copy(fontSize = 28.sp, lineHeight = 36.sp),
                textAlign = TextAlign.Center
            )
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                PosterAction(stringResource(R.string.poster_share), Modifier.weight(1f)) {
                    sharePoster(context, bitmaps[pager.currentPage])
                }
                PosterAction(stringResource(R.string.save), Modifier.weight(1f)) {
                    val page = pager.currentPage
                    val bitmap = bitmaps[page]
                    if (Build.VERSION.SDK_INT >= 29) {
                        val saved = savePoster(context, bitmap)
                        if (saved) haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                        Toast.makeText(context, if (saved) R.string.poster_saved else R.string.poster_save_failed, Toast.LENGTH_SHORT).show()
                    } else {
                        pendingPage = page
                        createDocument.launch("token-monitor.png")
                    }
                }
            }
        }
    }
}

@Composable
private fun kindLabel(card: ShareCard): String = when (card) {
    is ShareCard.Tokens -> stringResource(R.string.poster_kind_tokens)
    is ShareCard.Cost -> stringResource(R.string.poster_kind_cost)
    is ShareCard.Models -> stringResource(R.string.poster_kind_models)
    is ShareCard.Tools -> stringResource(R.string.poster_kind_tools)
    is ShareCard.Trend -> stringResource(R.string.poster_kind_trend)
}

@Composable
private fun PosterAction(label: String, modifier: Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .height(50.dp)
            .clip(RoundedCornerShape(25.dp))
            .background(Color.White)
            .clickable(remember { MutableInteractionSource() }, null, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Text(
            label,
            color = Color(0xFF1C1F26),
            fontWeight = FontWeight.SemiBold,
            fontSize = 18.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

private fun sharePoster(context: android.content.Context, bitmap: Bitmap) {
    val dir = File(context.cacheDir, "share").apply { mkdirs() }
    val file = File(dir, "token-monitor.png")
    file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "image/png"
        putExtra(Intent.EXTRA_STREAM, uri)
        clipData = android.content.ClipData.newUri(context.contentResolver, "poster", uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(Intent.createChooser(send, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
}

private fun savePoster(context: android.content.Context, bitmap: Bitmap): Boolean {
    val name = "token-monitor-${System.currentTimeMillis()}.png"
    val values = ContentValues().apply {
        put(MediaStore.Images.Media.DISPLAY_NAME, name)
        put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Token Monitor")
        put(MediaStore.Images.Media.IS_PENDING, 1)
    }
    val resolver = context.contentResolver
    val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return false
    val wrote = resolver.openOutputStream(uri)?.use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) } == true
    if (!wrote) {
        resolver.delete(uri, null, null)
        return false
    }
    values.clear()
    values.put(MediaStore.Images.Media.IS_PENDING, 0)
    resolver.update(uri, values, null, null)
    return true
}
