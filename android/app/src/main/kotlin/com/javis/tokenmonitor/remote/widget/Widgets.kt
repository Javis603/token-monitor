package com.javis.tokenmonitor.remote.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.util.TypedValue
import android.widget.RemoteViews
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.AndroidRemoteViews
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.layout.Alignment
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.javis.tokenmonitor.remote.MainActivity
import com.javis.tokenmonitor.remote.R
import com.javis.tokenmonitor.remote.core.ClientUsage
import com.javis.tokenmonitor.remote.core.DayUsage
import com.javis.tokenmonitor.remote.core.Format
import com.javis.tokenmonitor.remote.core.StatsSnapshot
import com.javis.tokenmonitor.remote.core.UNATTRIBUTED_ID
import com.javis.tokenmonitor.remote.data.SnapshotFile
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

private const val MIUI_APPWIDGET_UPDATE = "miui.appwidget.action.APPWIDGET_UPDATE"

private val TitleColor = ColorProvider(R.color.widget_secondary)
private val PrimaryColor = ColorProvider(R.color.widget_primary)
private val AccentColor = ColorProvider(R.color.widget_accent)
private val WarnColor = ColorProvider(R.color.widget_warn)

enum class WidgetShape {
    Narrow,
    Strip,
    Square,
    Wide
}

object WidgetUpdater {
    suspend fun update(context: Context) {
        listOf(Widget1x2(), Widget2x1(), Widget2x2(), Widget4x2()).forEach { it.updateAll(context) }
    }
}

abstract class MiuiWidgetReceiver : GlanceAppWidgetReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == MIUI_APPWIDGET_UPDATE) {
            val forwarded = Intent(intent).apply { action = AppWidgetManager.ACTION_APPWIDGET_UPDATE }
            super.onReceive(context, forwarded)
            return
        }
        super.onReceive(context, intent)
    }
}

internal open class UsageGlance(private val shape: WidgetShape) : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val snapshot = SnapshotFile.read(context)
        val root = RemoteViews(context.packageName, R.layout.widget_root)
        provideContent {
            AndroidRemoteViews(root, R.id.widget_content) {
                UsageContent(snapshot, shape)
            }
        }
    }
}

internal class Widget1x2 : UsageGlance(WidgetShape.Narrow)
internal class Widget2x1 : UsageGlance(WidgetShape.Strip)
internal class Widget2x2 : UsageGlance(WidgetShape.Square)
internal class Widget4x2 : UsageGlance(WidgetShape.Wide)

class Widget1x2Receiver : MiuiWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = Widget1x2()
}

class Widget2x1Receiver : MiuiWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = Widget2x1()
}

class Widget2x2Receiver : MiuiWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = Widget2x2()
}

class Widget4x2Receiver : MiuiWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = Widget4x2()
}

@Composable
private fun UsageContent(snapshot: StatsSnapshot?, shape: WidgetShape) {
    val context = LocalContext.current
    val open = actionStartActivity(
        Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
    )
    val inset = if (shape == WidgetShape.Narrow || shape == WidgetShape.Strip) 10.dp else 14.dp
    Column(
        modifier = GlanceModifier.fillMaxSize().clickable(open).padding(inset),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = if (shape == WidgetShape.Narrow) Alignment.CenterHorizontally else Alignment.Start
    ) {
        if (snapshot == null) {
            Text(
                context.getString(if (shape == WidgetShape.Narrow || shape == WidgetShape.Strip) R.string.widget_connect_short else R.string.widget_connect),
                style = titleStyle(12.sp),
                maxLines = 3
            )
            return@Column
        }
        when (shape) {
            WidgetShape.Narrow -> NarrowContent(context, snapshot)
            WidgetShape.Strip -> StripContent(context, snapshot)
            WidgetShape.Square -> SquareContent(context, snapshot)
            WidgetShape.Wide -> WideContent(context, snapshot)
        }
    }
}

@Composable
private fun NarrowContent(context: Context, snapshot: StatsSnapshot) {
    val width = (LocalSize.current.width - 20.dp).coerceAtLeast(24.dp)
    Text(context.getString(R.string.today), style = titleStyle(11.sp), maxLines = 1)
    FittedOrStackedTokens(snapshot.today.totalTokens, 22.sp, width)
    Text(Format.widgetCost(snapshot.today.costUsd, 1), style = accentStyle(12.sp), maxLines = 1)
    Spacer(GlanceModifier.height(4.dp))
    SyncMark(snapshot, showTime = true, showLabel = false)
}

@Composable
private fun StripContent(context: Context, snapshot: StatsSnapshot) {
    val label = context.getString(R.string.today_spend)
    val cost = Format.widgetCost(snapshot.today.costUsd, 2)
    val width = numberWidth(label, 12f, cost, 12f, reserved = 36.dp)
    Column(modifier = GlanceModifier.fillMaxSize()) {
        Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = titleStyle(12.sp), maxLines = 1)
            Spacer(GlanceModifier.defaultWeight())
            SyncMark(snapshot, showTime = false, showLabel = false)
        }
        Spacer(GlanceModifier.height(2.dp))
        Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            FittedTokenText(snapshot.today.totalTokens, 22.sp, width)
            Spacer(GlanceModifier.defaultWeight())
            Text(cost, style = accentStyle(12.sp), maxLines = 1)
        }
    }
}

@Composable
private fun SquareContent(context: Context, snapshot: StatsSnapshot) {
    val width = (LocalSize.current.width - 28.dp).coerceAtLeast(48.dp)
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(context.getString(R.string.today_tokens_heading), style = titleStyle(12.sp), maxLines = 1)
        Spacer(GlanceModifier.defaultWeight())
        SyncMark(snapshot, showTime = false, showLabel = false)
    }
    FittedTokenText(snapshot.today.totalTokens, 28.sp, width)
    Text(context.getString(R.string.widget_estimate, Format.widgetCost(snapshot.today.costUsd, 2)), style = accentStyle(13.sp), maxLines = 1)
    if (snapshot.week.isNotEmpty()) {
        Spacer(GlanceModifier.height(8.dp))
        WeekChart(snapshot.week, width)
        Spacer(GlanceModifier.height(4.dp))
        Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(context.getString(R.string.week_trend), style = titleStyle(11.sp), maxLines = 1)
            Spacer(GlanceModifier.defaultWeight())
            val clock = clockText(snapshot.updatedAt)
            if (clock != null) Text(clock, style = titleStyle(11.sp), maxLines = 1)
        }
    }
}

@Composable
private fun WideContent(context: Context, snapshot: StatsSnapshot) {
    val column = ((LocalSize.current.width - 28.dp - 12.dp) / 2).coerceAtLeast(48.dp)
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("●", style = TextStyle(color = AccentColor, fontSize = 8.sp))
        Spacer(GlanceModifier.width(4.dp))
        Text(context.getString(R.string.widget_brand), style = titleStyle(11.sp), maxLines = 1)
        Spacer(GlanceModifier.defaultWeight())
        SyncMark(snapshot, showTime = true, showLabel = true)
    }
    Spacer(GlanceModifier.height(8.dp))
    Row(modifier = GlanceModifier.fillMaxWidth()) {
        PeriodBlock(context.getString(R.string.today_spend), snapshot.today.totalTokens, snapshot.today.costUsd, column, GlanceModifier.defaultWeight())
        Spacer(GlanceModifier.width(12.dp))
        PeriodBlock(context.getString(R.string.month_total), snapshot.month.totalTokens, snapshot.month.costUsd, column, GlanceModifier.defaultWeight())
    }
    val model = snapshot.today.models.firstOrNull { it.tokens > 0 }
    val tool = snapshot.today.clients.firstOrNull { it.tokens > 0 }
    if (model != null || tool != null) {
        Spacer(GlanceModifier.height(8.dp))
        Row(modifier = GlanceModifier.fillMaxWidth()) {
            if (model != null) {
                DimensionBlock(context, context.getString(R.string.nav_models), model, snapshot.today.totalTokens, true, column, GlanceModifier.defaultWeight())
            } else {
                Spacer(GlanceModifier.defaultWeight())
            }
            Spacer(GlanceModifier.width(12.dp))
            if (tool != null) {
                DimensionBlock(context, context.getString(R.string.nav_tools), tool, snapshot.today.totalTokens, false, column, GlanceModifier.defaultWeight())
            } else {
                Spacer(GlanceModifier.defaultWeight())
            }
        }
    }
    Spacer(GlanceModifier.height(8.dp))
    Row(modifier = GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        if (snapshot.week.isNotEmpty()) {
            WeekChart(snapshot.week, column)
            Spacer(GlanceModifier.width(8.dp))
        }
        Spacer(GlanceModifier.defaultWeight())
        Text(context.getString(R.string.data_overview), style = titleStyle(11.sp), maxLines = 1)
    }
}

@Composable
private fun PeriodBlock(label: String, tokens: Long, cost: Double, width: Dp, modifier: GlanceModifier) {
    val context = LocalContext.current
    Column(modifier = modifier) {
        Text(label, style = titleStyle(12.sp), maxLines = 1)
        FittedTokenText(tokens, 26.sp, width)
        Text(context.getString(R.string.widget_estimate, Format.widgetCost(cost, 2)), style = accentStyle(12.sp), maxLines = 1)
    }
}

@Composable
private fun DimensionBlock(
    context: Context,
    label: String,
    entry: ClientUsage,
    total: Long,
    model: Boolean,
    width: Dp,
    modifier: GlanceModifier
) {
    val percent = if (total <= 0L) 0 else ((entry.tokens.toDouble() / total) * 100).roundToInt().coerceIn(0, 100)
    Column(modifier = modifier) {
        Text(label, style = titleStyle(12.sp), maxLines = 1)
        FittedTokenText(entry.tokens, 22.sp, width)
        Text(
            context.getString(R.string.share_line, entryName(context, entry.id, model), percent),
            style = titleStyle(11.sp),
            maxLines = 1
        )
    }
}

@Composable
private fun FittedTokenText(value: Long, size: androidx.compose.ui.unit.TextUnit, maxWidth: Dp) {
    val context = LocalContext.current
    Text(fittedTokenString(context, value, size, maxWidth), style = numberStyle(size), maxLines = 1)
}

@Composable
private fun FittedOrStackedTokens(value: Long, size: androidx.compose.ui.unit.TextUnit, maxWidth: Dp) {
    val context = LocalContext.current
    val text = fittedTokenString(context, value, size, maxWidth)
    val compact = Format.compactTokens(value)
    if (text == compact && !tokenFits(context, text, size, maxWidth)) {
        val (head, suffix) = splitCompact(compact)
        Text(head, style = numberStyle(size), maxLines = 1)
        if (suffix.isNotEmpty()) Text(suffix, style = numberStyle(size), maxLines = 1)
    } else {
        Text(text, style = numberStyle(size), maxLines = 1)
    }
}

@Composable
private fun WeekChart(week: List<DayUsage>, width: Dp) {
    val context = LocalContext.current
    val bitmap = remember(week, width) { weekBitmap(context, week, width.value, 28f) } ?: return
    val views = remember(bitmap) {
        RemoteViews(context.packageName, R.layout.widget_chart).apply {
            setImageViewBitmap(R.id.widget_chart, bitmap)
        }
    }
    AndroidRemoteViews(views, GlanceModifier.width(width).height(28.dp))
}

@Composable
private fun SyncMark(snapshot: StatsSnapshot, showTime: Boolean, showLabel: Boolean) {
    val context = LocalContext.current
    val stale = snapshot.anyDeviceStale
    val clock = clockText(snapshot.updatedAt)
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text("●", style = TextStyle(color = if (stale) WarnColor else AccentColor, fontSize = 8.sp))
        if (showTime && clock != null) {
            Spacer(GlanceModifier.width(4.dp))
            Text(clock, style = titleStyle(11.sp), maxLines = 1)
        }
        if (showLabel) {
            Spacer(GlanceModifier.width(4.dp))
            Text(
                context.getString(if (stale) R.string.stale else R.string.synced_at),
                style = if (stale) warnStyle(11.sp) else titleStyle(11.sp),
                maxLines = 1
            )
        }
    }
}

@Composable
private fun numberWidth(leading: String, leadingSp: Float, trailing: String, trailingSp: Float, reserved: Dp): Dp {
    val context = LocalContext.current
    val density = context.resources.displayMetrics.density
    val total = LocalSize.current.width.value * density
    val used = tokenPaint(context, leadingSp).measureText(leading) + tokenPaint(context, trailingSp).measureText(trailing)
    val reservedPx = reserved.value * density
    return ((total - used - reservedPx) / density).dp.coerceAtLeast(24.dp)
}

private fun fittedTokenString(context: Context, value: Long, size: androidx.compose.ui.unit.TextUnit, maxWidth: Dp): String {
    val paint = tokenPaint(context, size.value)
    val max = dpToPx(context, maxWidth.value)
    return Format.tokensForWidth(value) { paint.measureText(it) <= max }
}

private fun tokenFits(context: Context, text: String, size: androidx.compose.ui.unit.TextUnit, maxWidth: Dp): Boolean {
    return tokenPaint(context, size.value).measureText(text) <= dpToPx(context, maxWidth.value)
}

private fun tokenPaint(context: Context, sizeSp: Float): TextPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
    textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, sizeSp, context.resources.displayMetrics)
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
}

private fun dpToPx(context: Context, dp: Float): Float {
    return TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, context.resources.displayMetrics)
}

private fun splitCompact(text: String): Pair<String, String> {
    val index = text.indexOfFirst { it.isLetter() }
    if (index <= 0) return text to ""
    return text.substring(0, index) to text.substring(index)
}

private fun weekBitmap(context: Context, week: List<DayUsage>, widthDp: Float, heightDp: Float): Bitmap? {
    if (week.isEmpty() || week.none { it.tokens != null }) return null
    val width = dpToPx(context, widthDp).toInt().coerceIn(1, 1400)
    val height = dpToPx(context, heightDp).toInt().coerceIn(1, 400)
    val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ContextCompat.getColor(context, R.color.widget_bar) }
    val peak = week.maxOf { it.tokens ?: 0L }.coerceAtLeast(1L)
    val slot = width.toFloat() / week.size
    val barWidth = slot * 0.55f
    val radius = barWidth / 2f
    week.forEachIndexed { index, day ->
        val tokens = day.tokens ?: return@forEachIndexed
        val fraction = tokens.toFloat() / peak.toFloat()
        val stub = height * 0.08f
        val barHeight = if (tokens == 0L) stub else (height * fraction).coerceAtLeast(stub)
        val left = index * slot + (slot - barWidth) / 2f
        canvas.drawRoundRect(RectF(left, height - barHeight, left + barWidth, height.toFloat()), radius, radius, paint)
    }
    return bitmap
}

private fun entryName(context: Context, id: String, model: Boolean): String {
    if (id == UNATTRIBUTED_ID) return context.getString(R.string.unattributed)
    if (model) return id
    return id.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.getDefault()) else it.toString() }
}

private fun titleStyle(size: androidx.compose.ui.unit.TextUnit) =
    TextStyle(color = TitleColor, fontSize = size, fontWeight = FontWeight.Medium)

private fun numberStyle(size: androidx.compose.ui.unit.TextUnit) =
    TextStyle(color = PrimaryColor, fontSize = size, fontWeight = FontWeight.Bold)

private fun accentStyle(size: androidx.compose.ui.unit.TextUnit) =
    TextStyle(color = AccentColor, fontSize = size, fontWeight = FontWeight.Medium)

private fun warnStyle(size: androidx.compose.ui.unit.TextUnit) =
    TextStyle(color = WarnColor, fontSize = size, fontWeight = FontWeight.Medium)

private fun clockText(iso: String): String? = try {
    DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(iso))
} catch (_: Exception) {
    null
}
