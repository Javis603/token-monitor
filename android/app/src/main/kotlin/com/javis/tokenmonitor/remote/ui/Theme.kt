package com.javis.tokenmonitor.remote.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val Dark = darkColorScheme(
    primary = Color(0xFFF2F2F7),
    onPrimary = Color(0xFF111111),
    background = Color(0xFF000000),
    onBackground = Color(0xFFF5F5F7),
    surface = Color(0xFF1C1C1E),
    onSurface = Color(0xFFF5F5F7),
    surfaceVariant = Color(0xFF2C2C2E),
    onSurfaceVariant = Color(0xFFC7C7CC),
    outline = Color(0xFF48484A),
    outlineVariant = Color(0xFF3A3A3C),
    error = Color(0xFFFF8A96),
    onError = Color(0xFF1C1C1E)
)

private val Light = lightColorScheme(
    primary = Color(0xFF2563EB),
    onPrimary = Color.White,
    background = Color(0xFFF6F7F9),
    onBackground = Color(0xFF1C1F26),
    surface = Color.White,
    onSurface = Color(0xFF1C1F26),
    surfaceVariant = Color(0xFFEDEFF3),
    onSurfaceVariant = Color(0xFF5B626D),
    outline = Color(0xFFB6BEC8),
    outlineVariant = Color(0xFFD9DEE5),
    error = Color(0xFFC53B53),
    onError = Color.White
)

data class GraphiteExtraColors(
    val chartPrimary: Color,
    val success: Color,
    val warning: Color,
    val progressTrack: Color,
    val metricNumber: Color
)

val LocalGraphiteExtraColors = staticCompositionLocalOf {
    GraphiteExtraColors(Color.Unspecified, Color.Unspecified, Color.Unspecified, Color.Unspecified, Color.Unspecified)
}

private val GraphiteTypography = Typography(
    headlineSmall = TextStyle(fontSize = 24.sp, lineHeight = 32.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 18.sp),
    displaySmall = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 36.sp,
        lineHeight = 44.sp,
        fontWeight = FontWeight.SemiBold
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        fontWeight = FontWeight.SemiBold
    )
)

private val GraphiteShapes = Shapes(
    extraSmall = RoundedCornerShape(10.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(18.dp),
    extraLarge = RoundedCornerShape(24.dp)
)

@Composable
fun TokenMonitorTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val extra = if (dark) {
        GraphiteExtraColors(
            chartPrimary = Color(0xFF8EB4E0),
            success = Color(0xFFD1D1D6),
            warning = Color(0xFFF0A36A),
            progressTrack = Color(0xFF3A3A3C),
            metricNumber = Color(0xFFF5F5F7)
        )
    } else {
        GraphiteExtraColors(
            chartPrimary = Color(0xFF357CB5),
            success = Color(0xFF18794E),
            warning = Color(0xFFA65321),
            progressTrack = Color(0xFFE2E7ED),
            metricNumber = Color(0xFF1C1F26)
        )
    }
    val scheme = if (dark) Dark else Light
    CompositionLocalProvider(LocalGraphiteExtraColors provides extra) {
        MaterialTheme(
            colorScheme = scheme,
            typography = GraphiteTypography,
            shapes = GraphiteShapes
        ) {
            // MaterialTheme does not set a content color. Unspecified text then
            // draws as black, which disappears on the dark backdrop.
            CompositionLocalProvider(LocalContentColor provides scheme.onSurface, content = content)
        }
    }
}
