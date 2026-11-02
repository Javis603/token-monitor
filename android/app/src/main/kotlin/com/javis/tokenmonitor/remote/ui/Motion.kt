package com.javis.tokenmonitor.remote.ui

import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextMeasurer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

object Motion {
    const val PressMs = 120
    const val PageMs = 240
    const val FadeMs = 160
    const val CountMs = 360
    const val MeterMs = 240
    const val PressScale = 0.97f
}

@Composable
fun motionScale(): Float {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    }
}

@Composable
fun <T> motionTween(durationMillis: Int): FiniteAnimationSpec<T> {
    val scale = motionScale()
    return if (scale <= 0f) snap() else tween((durationMillis * scale).toInt().coerceAtLeast(1))
}

@Composable
fun <T> motionSpring(): FiniteAnimationSpec<T> {
    val scale = motionScale()
    return if (scale <= 0f) {
        snap()
    } else {
        spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMediumLow)
    }
}

@Composable
fun Modifier.pressScale(source: MutableInteractionSource): Modifier {
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) Motion.PressScale else 1f,
        animationSpec = motionTween(Motion.PressMs),
        label = "press"
    )
    return graphicsLayer {
        scaleX = scale
        scaleY = scale
    }
}

@Composable
fun SelectionCapsule(
    selected: Int,
    count: Int,
    color: Color,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit
) {
    val index by animateFloatAsState(
        targetValue = selected.coerceIn(0, (count - 1).coerceAtLeast(0)).toFloat(),
        animationSpec = motionSpring(),
        label = "selection"
    )
    BoxWithConstraints(modifier) {
        val cell = if (count <= 0) maxWidth else maxWidth / count
        Box(
            Modifier
                .offset(x = cell * index)
                .width(cell)
                .fillMaxHeight()
                .clip(RoundedCornerShape(24.dp))
                .background(color)
        )
        content()
    }
}

@Composable
fun RollingText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val measurer = rememberTextMeasurer()
    val enabled = motionScale() > 0f
    val spec = motionTween<Float>(Motion.CountMs)
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        text.forEachIndexed { index, symbol ->
            key(text.length - index) {
                RollingGlyph(symbol, style, color, measurer, enabled, spec)
            }
        }
    }
}

@Composable
private fun RollingGlyph(
    symbol: Char,
    style: TextStyle,
    color: Color,
    measurer: TextMeasurer,
    enabled: Boolean,
    spec: FiniteAnimationSpec<Float>
) {
    var shown by remember { mutableStateOf(symbol) }
    val shift = remember { Animatable(0f) }
    LaunchedEffect(symbol, enabled) {
        if (shown == symbol) return@LaunchedEffect
        val roll = enabled && shown.isDigit() && symbol.isDigit()
        if (!roll) {
            shown = symbol
            shift.snapTo(0f)
            return@LaunchedEffect
        }
        shift.snapTo(0f)
        shift.animateTo(1f, spec)
        shown = symbol
        shift.snapTo(0f)
    }
    val density = LocalDensity.current
    val sample = if (symbol.isDigit() || shown.isDigit()) "0" else symbol.toString()
    val measured = remember(measurer, sample, style, density.density, density.fontScale) {
        measurer.measure(sample, style = style, maxLines = 1, softWrap = false).size
    }
    val width = with(density) { measured.width.toDp() }
    val line = with(density) {
        val size = if (style.fontSize != androidx.compose.ui.unit.TextUnit.Unspecified) style.fontSize.toPx() else 16.dp.toPx()
        size * 1.25f
    }
    Box(Modifier.width(width).height(with(density) { line.toDp() }).clipToBounds()) {
        Glyph(shown, style, color, Modifier.offset { IntOffset(0, (-shift.value * line).roundToInt()) })
        if (shown != symbol) {
            Glyph(symbol, style, color, Modifier.offset { IntOffset(0, ((1f - shift.value) * line).roundToInt()) })
        }
    }
}

@Composable
private fun Glyph(symbol: Char, style: TextStyle, color: Color, modifier: Modifier) {
    Text(symbol.toString(), modifier = modifier, style = style, color = color, maxLines = 1, softWrap = false, overflow = TextOverflow.Clip)
}
