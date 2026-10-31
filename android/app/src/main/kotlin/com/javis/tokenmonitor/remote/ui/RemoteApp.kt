package com.javis.tokenmonitor.remote.ui

import android.Manifest
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import com.javis.tokenmonitor.remote.widget.Widget1x2Receiver
import com.javis.tokenmonitor.remote.widget.Widget2x1Receiver
import com.javis.tokenmonitor.remote.widget.Widget2x2Receiver
import com.javis.tokenmonitor.remote.widget.Widget4x2Receiver
import android.content.pm.PackageManager
import android.os.Build
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.statusBars
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshState
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.javis.tokenmonitor.remote.R
import com.javis.tokenmonitor.remote.core.ClientUsage
import com.javis.tokenmonitor.remote.core.DayUsage
import com.javis.tokenmonitor.remote.core.Format
import com.javis.tokenmonitor.remote.core.HistorySummary
import com.javis.tokenmonitor.remote.core.HubFailure
import com.javis.tokenmonitor.remote.core.LimitWindow
import com.javis.tokenmonitor.remote.core.PeriodId
import com.javis.tokenmonitor.remote.core.StatsSnapshot
import com.javis.tokenmonitor.remote.core.UNATTRIBUTED_ID
import com.javis.tokenmonitor.remote.core.shareCards
import com.javis.tokenmonitor.remote.data.ConnectResult
import kotlin.math.roundToInt
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.WeekFields
import java.util.Locale

@Composable
fun RemoteApp(model: RemoteViewModel) {
    val state by model.state.collectAsStateWithLifecycle()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, model) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> model.onForeground(true)
                Lifecycle.Event.ON_STOP -> model.onForeground(false)
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    TokenMonitorTheme {
        AppBackdrop {
            val gate = when {
                !state.ready -> "boot"
                !state.configured -> "setup"
                else -> "home"
            }
            val swap = fadeIn(motionTween(Motion.PageMs)) togetherWith fadeOut(motionTween(Motion.FadeMs))
            AnimatedContent(
                targetState = gate,
                modifier = Modifier.fillMaxSize(),
                transitionSpec = { swap },
                label = "gate"
            ) { mode ->
                when (mode) {
                    "setup" -> SetupScreen(
                        busy = state.busy,
                        error = connectMessage(state.connectResult),
                        onConnect = model::connect
                    )
                    "home" -> Home(state, model)
                    else -> Column(Modifier.fillMaxSize()) {}
                }
            }
        }
    }
}

@Composable
private fun AppBackdrop(fade: Boolean = true, content: @Composable () -> Unit) {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val top = if (dark) Color(0xFF000000) else Color(0xFFE4EDF6)
    val mid = if (dark) Color(0xFF0C0C0E) else Color(0xFFF4F7FB)
    val bottom = if (dark) Color(0xFF000000) else Color(0xFFE7EEF4)
    Box(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().background(Brush.verticalGradient(listOf(top, mid, bottom))))
        Box(
            Modifier
                .size(340.dp)
                .align(Alignment.TopEnd)
                .offset(x = 90.dp, y = (-80).dp)
                .background(Brush.radialGradient(listOf(Color(0xFF73BDF5).copy(alpha = if (dark) 0.22f else 0.55f), Color.Transparent)))
        )
        Box(
            Modifier
                .size(300.dp)
                .align(Alignment.BottomStart)
                .offset(x = (-80).dp, y = 30.dp)
                .background(Brush.radialGradient(listOf(Color(0xFFB7EAD4).copy(alpha = if (dark) 0.14f else 0.50f), Color.Transparent)))
        )
        Box(Modifier.fillMaxSize()) { content() }
        if (fade) {
            val fadeHeight = WindowInsets.statusBars.asPaddingValues().calculateTopPadding() + 16.dp
            Box(
                Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .height(fadeHeight)
                    .background(Brush.verticalGradient(listOf(top, top.copy(alpha = 0f))))
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun Home(state: UiState, model: RemoteViewModel) {
    var settingsOpen by remember { mutableStateOf(false) }
    var limitsOpen by remember { mutableStateOf(false) }
    var shareOpen by remember { mutableStateOf(false) }
    val posters = state.snapshot?.let { shareCards(it, state.period) }.orEmpty()
    LaunchedEffect(state.connectResult) {
        if (state.connectResult is ConnectResult.Connected) settingsOpen = false
    }
    LaunchedEffect(posters.isEmpty()) {
        if (posters.isEmpty()) shareOpen = false
    }
    BackHandler(enabled = settingsOpen || limitsOpen || shareOpen) {
        when {
            shareOpen -> shareOpen = false
            settingsOpen -> {
                settingsOpen = false
                model.clearConnectResult()
            }
            else -> limitsOpen = false
        }
    }
    val openSettings = {
        settingsOpen = true
    }
    val cover = with(LocalDensity.current) { 16.dp.roundToPx() }
    val coverShift = motionTween<androidx.compose.ui.unit.IntOffset>(Motion.PageMs)
    val coverFade = motionTween<Float>(Motion.PageMs)
    Box(Modifier.fillMaxSize()) {
        val pullState = rememberPullToRefreshState()
        PullToRefreshBox(
            isRefreshing = state.refreshing,
            onRefresh = model::refresh,
            state = pullState,
            modifier = Modifier.fillMaxSize(),
            indicator = { GlassRefreshIndicator(pullState, state.refreshing) }
        ) {
            val push = with(LocalDensity.current) { 48.dp.roundToPx() }
            val shift = motionTween<androidx.compose.ui.unit.IntOffset>(Motion.PageMs)
            val fade = motionTween<Float>(Motion.PageMs)
            AnimatedContent(
                targetState = limitsOpen,
                modifier = Modifier.fillMaxSize(),
                transitionSpec = {
                    val change = if (targetState) {
                        (slideInHorizontally(shift) { push } + fadeIn(fade)) togetherWith
                            (slideOutHorizontally(shift) { -push / 3 } + fadeOut(fade))
                    } else {
                        (slideInHorizontally(shift) { -push / 3 } + fadeIn(fade)) togetherWith
                            (slideOutHorizontally(shift) { push } + fadeOut(fade))
                    }
                    change.using(SizeTransform(clip = false))
                },
                label = "limits"
            ) { open ->
                if (open) {
                    LimitsPage(state, openSettings) { limitsOpen = false }
                } else {
                    val rise = with(LocalDensity.current) { 8.dp.roundToPx() }
                    AnimatedContent(
                        targetState = state.tab,
                        modifier = Modifier.fillMaxSize(),
                        transitionSpec = {
                            ((fadeIn(fade) + slideInVertically(shift) { rise }) togetherWith
                                (fadeOut(fade) + slideOutVertically(shift) { -rise }))
                                .using(SizeTransform(clip = false))
                        },
                        label = "tab"
                    ) { tab ->
                        when (tab) {
                            Tab.Home -> UsagePage(state, model, openSettings, { limitsOpen = true }, if (posters.isNotEmpty()) ({ shareOpen = true }) else null)
                            Tab.Tools -> AttributionPage(
                                title = stringResource(R.string.nav_tools),
                                state = state,
                                onSettings = openSettings,
                                onPeriod = model::selectPeriod,
                                rows = state.snapshot?.period(state.period)?.clients.orEmpty().filter { it.tokens > 0 },
                                empty = stringResource(R.string.empty_clients),
                                nameOf = { providerName(it.id) }
                            )
                            Tab.Models -> AttributionPage(
                                title = stringResource(R.string.nav_models),
                                state = state,
                                onSettings = openSettings,
                                onPeriod = model::selectPeriod,
                                rows = state.snapshot?.period(state.period)?.models.orEmpty().filter { it.tokens > 0 },
                                empty = stringResource(R.string.empty_models),
                                nameOf = { if (it.id == UNATTRIBUTED_ID) stringResource(R.string.unattributed) else it.id }
                            )
                            Tab.Analysis -> AnalysisPage(state, openSettings, model::selectPeriod)
                        }
                    }
                }
            }
        }
        SystemGlassNav(state.tab.ordinal, visible = !settingsOpen && !limitsOpen && !shareOpen) { index ->
            model.selectTab(Tab.entries[index])
        }
        AnimatedVisibility(
            visible = shareOpen && posters.isNotEmpty(),
            modifier = Modifier.fillMaxSize(),
            enter = fadeIn(coverFade) + slideInVertically(coverShift) { cover },
            exit = fadeOut(coverFade) + slideOutVertically(coverShift) { cover }
        ) {
            val periodLabel = when (state.period) {
                PeriodId.Today -> stringResource(R.string.today)
                PeriodId.Month -> stringResource(R.string.month)
                PeriodId.AllTime -> stringResource(R.string.all_time)
            }
            ShareSheet(posters, periodLabel) { shareOpen = false }
        }
    }
    AnimatedVisibility(
        visible = settingsOpen,
        modifier = Modifier.fillMaxSize(),
        enter = fadeIn(coverFade) + slideInVertically(coverShift) { cover },
        exit = fadeOut(coverFade) + slideOutVertically(coverShift) { cover }
    ) {
        SettingsScreen(
            url = state.hubUrl,
            busy = state.busy,
            error = connectMessage(state.connectResult),
            islandEnabled = state.islandEnabled,
            onIsland = model::setIsland,
            onDismiss = {
                settingsOpen = false
                model.clearConnectResult()
            },
            onSave = model::connect
        )
    }
}

@Composable
private fun BoxScope.GlassRefreshIndicator(state: PullToRefreshState, refreshing: Boolean) {
    val fraction = state.distanceFraction
    if (!refreshing && fraction <= 0f) return
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val travel = if (refreshing) 1f else fraction.coerceIn(0f, 1.3f)
    val top = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    val spin = remember { androidx.compose.animation.core.Animatable(0f) }
    LaunchedEffect(refreshing) {
        if (!refreshing) {
            spin.snapTo(0f)
            return@LaunchedEffect
        }
        while (true) {
            spin.snapTo(0f)
            spin.animateTo(360f, androidx.compose.animation.core.tween(900, easing = androidx.compose.animation.core.LinearEasing))
        }
    }
    val arc = LocalGraphiteExtraColors.current.chartPrimary
        SoftGlass(
        Modifier
            .align(Alignment.TopCenter)
            .offset(y = top + 8.dp + 28.dp * travel)
            .size(40.dp)
            .graphicsLayer { alpha = if (refreshing) 1f else travel.coerceIn(0f, 1f) },
        shape = CircleShape,
        corner = 20.dp,
        veil = if (dark) 0.72f else 0.9f,
        blur = true
    ) {
        Canvas(Modifier.fillMaxSize().padding(11.dp)) {
            drawArc(
                color = arc,
                startAngle = if (refreshing) spin.value else -90f,
                sweepAngle = if (refreshing) 270f else travel.coerceIn(0f, 1f) * 300f,
                useCenter = false,
                style = androidx.compose.ui.graphics.drawscope.Stroke(
                    width = 2.5.dp.toPx(),
                    cap = androidx.compose.ui.graphics.StrokeCap.Round
                )
            )
        }
    }
}

@Composable
private fun RowScope.NavItem(selected: Boolean, label: Int, icon: Int, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    val tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
    Column(
        Modifier
            .weight(1f)
            .fillMaxSize()
            .clickable(source, null, onClick = onClick)
            .pressScale(source),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Icon(painterResource(icon), contentDescription = null, modifier = Modifier.size(22.dp), tint = tint)
        Text(
            stringResource(label),
            style = MaterialTheme.typography.bodySmall,
            color = tint,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            maxLines = 1
        )
    }
}

@Composable
private fun GlassField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    secret: Boolean = false,
    placeholder: String? = null
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SoftGlass(Modifier.fillMaxWidth().height(52.dp), shape = RoundedCornerShape(18.dp), corner = 18.dp, veil = 1f, blur = true) {
            Box(Modifier.fillMaxSize().padding(horizontal = 16.dp), contentAlignment = Alignment.CenterStart) {
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    singleLine = true,
                    textStyle = TextStyle(color = MaterialTheme.colorScheme.onSurface, fontSize = MaterialTheme.typography.bodyMedium.fontSize),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                    decorationBox = { inner ->
                        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterStart) {
                            if (value.isEmpty() && placeholder != null) {
                                Text(
                                    placeholder,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                            inner()
                        }
                    },
                    modifier = Modifier.fillMaxWidth()
                )
            }
        }
    }
}

@Composable
private fun CapsuleButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .height(50.dp)
            .clip(RoundedCornerShape(25.dp))
            .background(MaterialTheme.colorScheme.primary.copy(alpha = if (enabled) 1f else 0.38f))
            .clickable(remember { MutableInteractionSource() }, null, enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Text(label, color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun QuietAction(label: String, onClick: () -> Unit, enabled: Boolean = true, emphasis: Boolean = false) {
    Text(
        label,
        color = MaterialTheme.colorScheme.primary.copy(alpha = if (enabled) 1f else 0.38f),
        fontWeight = if (emphasis) FontWeight.SemiBold else FontWeight.Normal,
        modifier = Modifier
            .clickable(remember { MutableInteractionSource() }, null, enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp)
    )
}

@Composable
private fun GlassSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val travel by animateDpAsState(
        targetValue = if (checked) 20.dp else 0.dp,
        animationSpec = motionSpring(),
        label = "switch"
    )
    val track by animateColorAsState(
        targetValue = if (checked) {
            if (dark) Color(0xFFE5E5EA) else MaterialTheme.colorScheme.primary
        } else {
            if (dark) Color(0xFF3A3A3C) else Color(0xFFD5DBE3)
        },
        animationSpec = motionTween(Motion.PageMs),
        label = "track"
    )
    val thumb by animateColorAsState(
        targetValue = if (dark && checked) Color(0xFF1C1C1E) else Color.White,
        animationSpec = motionTween(Motion.PageMs),
        label = "thumb"
    )
    Box(
        Modifier
            .size(width = 51.dp, height = 31.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(track)
            .clickable(remember { MutableInteractionSource() }, null) { onCheckedChange(!checked) }
    ) {
        Box(
            Modifier
                .padding(start = 2.dp, top = 2.dp)
                .offset(x = travel)
                .size(27.dp)
                .background(thumb, CircleShape)
        )
    }
}

@Composable
private fun SetupScreen(busy: Boolean, error: String?, onConnect: (String, String) -> Unit) {
    var url by remember { mutableStateOf("") }
    var secret by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().statusBarsPadding().padding(24.dp),
        verticalArrangement = Arrangement.Center
    ) {
        Text(stringResource(R.string.setup_title), style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(8.dp))
        Text(stringResource(R.string.setup_body), style = MaterialTheme.typography.bodyMedium)
        Spacer(Modifier.height(24.dp))
        GlassField(url, { url = it }, stringResource(R.string.hub_url))
        Spacer(Modifier.height(12.dp))
        GlassField(secret, { secret = it }, stringResource(R.string.hub_secret), secret = true)
        if (error != null) {
            Spacer(Modifier.height(12.dp))
            Text(error, color = MaterialTheme.colorScheme.error)
        }
        Spacer(Modifier.height(20.dp))
        CapsuleButton(stringResource(R.string.connect), enabled = !busy) { onConnect(url, secret) }
    }
}

@Composable
private fun SettingsScreen(
    url: String,
    busy: Boolean,
    error: String?,
    islandEnabled: Boolean,
    onIsland: (Boolean) -> Unit,
    onDismiss: () -> Unit,
    onSave: (String, String) -> Unit
) {
    var draftUrl by remember(url) { mutableStateOf(url) }
    var secret by remember { mutableStateOf("") }
    AppBackdrop(fade = false) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = pageContentPadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item {
                PageHeader(stringResource(R.string.settings), {}, onBack = onDismiss)
            }
            item {
                GraphitePanel {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        GlassField(draftUrl, { draftUrl = it }, stringResource(R.string.hub_url))
                        GlassField(
                            secret,
                            { secret = it },
                            stringResource(R.string.hub_secret),
                            secret = true,
                            placeholder = stringResource(R.string.secret_keep)
                        )
                        if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
                        CapsuleButton(stringResource(R.string.save), enabled = !busy) { onSave(draftUrl, secret) }
                    }
                }
            }
            item { IslandSwitch(islandEnabled, onIsland) }
            item { PinWidgets() }
        }
    }
}

@Composable
private fun pageContentPadding(): PaddingValues {
    val density = LocalDensity.current
    val top = with(density) { WindowInsets.statusBars.getTop(density).toDp() }
    return PaddingValues(start = 16.dp, end = 16.dp, top = top + 28.dp, bottom = 108.dp)
}

@Composable
private fun PageHeader(
    title: String,
    subtitle: @Composable () -> Unit,
    onSettings: (() -> Unit)? = null,
    onBack: (() -> Unit)? = null,
    onShare: (() -> Unit)? = null
) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 20.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (onBack != null) {
            GlassIconButton(R.drawable.ic_back, stringResource(R.string.back), onBack)
            Spacer(Modifier.size(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.headlineSmall)
            subtitle()
        }
        if (onShare != null) {
            GlassIconButton(R.drawable.ic_share, stringResource(R.string.poster_share), onShare)
            Spacer(Modifier.size(8.dp))
        }
        if (onSettings != null) {
            GlassIconButton(R.drawable.ic_settings, stringResource(R.string.settings), onSettings)
        }
    }
}

@Composable
internal fun GlassIconButton(icon: Int, description: String, onClick: () -> Unit) {
    val source = remember { MutableInteractionSource() }
    SoftGlass(
        Modifier.size(44.dp),
        shape = RoundedCornerShape(22.dp),
        corner = 22.dp,
        veil = 1f
    ) {
        Box(
            Modifier.fillMaxSize().clickable(source, null, onClick = onClick).pressScale(source),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                painterResource(icon),
                contentDescription = description,
                modifier = Modifier.size(22.dp),
                tint = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}

@Composable
private fun GraphitePanel(
    modifier: Modifier = Modifier.fillMaxWidth(),
    blur: Boolean = false,
    content: @Composable () -> Unit
) {
    SoftGlass(modifier, shape = RoundedCornerShape(28.dp), corner = 28.dp, veil = 1f, blur = blur, content = { content() })
}

@Composable
private fun selectionThumb(): Color =
    if (androidx.compose.foundation.isSystemInDarkTheme()) Color.White.copy(alpha = 0.28f) else Color.White

@Composable
private fun PeriodControl(selected: PeriodId, onSelect: (PeriodId) -> Unit) {
    val options = listOf(PeriodId.Today to R.string.today, PeriodId.Month to R.string.month, PeriodId.AllTime to R.string.all_time)
    SoftGlass(Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(24.dp), corner = 24.dp, veil = 1f, blur = true) {
        SelectionCapsule(
            selected = options.indexOfFirst { it.first == selected }.coerceAtLeast(0),
            count = options.size,
            color = selectionThumb(),
            modifier = Modifier.fillMaxSize().padding(4.dp)
        ) {
            Row(Modifier.fillMaxSize()) {
                options.forEach { (id, label) ->
                    val on = selected == id
                    val color by animateColorAsState(
                        targetValue = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                        animationSpec = motionTween(Motion.FadeMs),
                        label = "period"
                    )
                    Box(
                        Modifier
                            .weight(1f)
                            .fillMaxSize()
                            .clickable(remember { MutableInteractionSource() }, null) { onSelect(id) },
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            stringResource(label),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            color = color
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun UsagePage(
    state: UiState,
    model: RemoteViewModel,
    onSettings: () -> Unit,
    onLimits: () -> Unit,
    onShare: (() -> Unit)?
) {
    val snapshot = state.snapshot
    val period = snapshot?.period(state.period)
    val extra = LocalGraphiteExtraColors.current
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = pageContentPadding(),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            PageHeader(
                title = stringResource(R.string.nav_home),
                subtitle = { DeviceStatus(snapshot) },
                onSettings = onSettings,
                onShare = onShare
            )
            PeriodControl(state.period, model::selectPeriod)
        }
        item { FailureText(state.failure) }
        if (snapshot == null || period == null) {
            item { Text(stringResource(R.string.retry), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            item {
                GraphitePanel(blur = true) {
                    Column(Modifier.padding(16.dp)) {
                        Text(
                            stringResource(R.string.usage_total),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        FittedTokens(
                            period.totalTokens,
                            MaterialTheme.typography.displaySmall,
                            color = extra.metricNumber,
                            modifier = Modifier.fillMaxWidth(),
                            roll = true
                        )
                        RollingText(
                            stringResource(R.string.hero_cost, Format.costUsd(period.costUsd)),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        val updated = formatInstant(snapshot.updatedAt)
                        if (updated != null) {
                            Spacer(Modifier.height(8.dp))
                            Text(
                                stringResource(R.string.updated, updated),
                                style = MaterialTheme.typography.bodySmall,
                                color = extra.success
                            )
                        }
                    }
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.quota_summary), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    Text(stringResource(R.string.see_all), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Medium, modifier = Modifier.clickable(remember { MutableInteractionSource() }, null, onClick = onLimits))
                }
            }
            val highlights = snapshot.providers.flatMap { provider ->
                provider.windows.map { window -> provider to window }
            }.take(2)
            if (highlights.isEmpty()) {
                item { Text(stringResource(R.string.empty_limits), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } else {
                items(highlights, key = { "${it.first.provider}:${it.second.label}:${it.second.kind}" }) { (provider, window) ->
                    GraphitePanel {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(providerName(provider.provider), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                                if (provider.planLabel.isNotBlank()) {
                                    Text(provider.planLabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                            WindowRow(window)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun LimitsPage(state: UiState, onSettings: () -> Unit, onBack: () -> Unit) {
    val providers = state.snapshot?.providers.orEmpty()
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = pageContentPadding(),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            PageHeader(stringResource(R.string.limits), {
                Text(stringResource(R.string.quota_summary), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }, onSettings, onBack)
        }
        item { FailureText(state.failure) }
        if (providers.isEmpty()) {
            item { Text(stringResource(R.string.empty_limits), color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        itemsIndexed(providers, key = { index, provider -> "$index:${provider.provider}:${provider.accountKey}" }) { _, provider ->
            GraphitePanel {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(providerName(provider.provider), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                        if (provider.planLabel.isNotBlank()) {
                            Text(provider.planLabel, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    val status = statusText(provider.status)
                    if (provider.stale || status != null) {
                        val bits = listOfNotNull(if (provider.stale) stringResource(R.string.stale) else null, status)
                        Text(bits.joinToString(" · "), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                    provider.windows.forEach { window -> WindowRow(window) }
                }
            }
        }
    }
}

@Composable
private fun WindowRow(window: LimitWindow) {
    val extra = LocalGraphiteExtraColors.current
    val percent = window.usedPercent
    val money = window.remaining
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(window.label.ifBlank { window.kind }, style = MaterialTheme.typography.bodyMedium)
        when {
            percent != null && window.showMeter -> {
                val left = (100.0 - percent).roundToInt().coerceIn(0, 100)
                val fraction by animateFloatAsState(
                    targetValue = left / 100f,
                    animationSpec = motionTween(Motion.MeterMs),
                    label = "meter"
                )
                Box(
                    Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(999.dp)).background(extra.progressTrack)
                ) {
                    Box(
                        Modifier.fillMaxWidth(fraction).fillMaxHeight().background(extra.chartPrimary)
                    )
                }
                Text(
                    stringResource(R.string.remaining_percent, left),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (left < 20) extra.warning else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1
                )
            }
            window.metric == "credits" && money != null -> {
                FittedLine(
                    Format.amount(money, window.currency),
                    MaterialTheme.typography.titleLarge,
                    extra.metricNumber,
                    Modifier.fillMaxWidth()
                )
            }
            percent != null -> {
                    Text(
                        stringResource(R.string.remaining_percent, (100.0 - percent).roundToInt().coerceIn(0, 100)),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1
                    )
            }
        }
        val reset = window.resetsAt?.let(::formatInstant)
        if (reset != null) {
            Text(stringResource(R.string.resets, reset), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun AttributionPage(
    title: String,
    state: UiState,
    onSettings: () -> Unit,
    onPeriod: (PeriodId) -> Unit,
    rows: List<ClientUsage>,
    empty: String,
    nameOf: @Composable (ClientUsage) -> String
) {
    val total = state.snapshot?.period(state.period)?.totalTokens ?: 0L
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = pageContentPadding(),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        item {
            PageHeader(title, { DeviceStatus(state.snapshot) }, onSettings)
            PeriodControl(state.period, onPeriod)
        }
        item { FailureText(state.failure) }
        if (rows.isEmpty()) {
            item { Text(empty, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        } else {
            items(rows, key = { it.id }) { row ->
                UsageAmountRow(nameOf(row), row.tokens, total)
            }
        }
    }
}

private enum class AnalysisPane { Overview, Trends }

@Composable
private fun AnalysisPage(state: UiState, onSettings: () -> Unit, onPeriod: (PeriodId) -> Unit) {
    val snapshot = state.snapshot
    var pane by remember { mutableStateOf(AnalysisPane.Overview) }
    var shareByTool by remember { mutableStateOf(true) }
    var breakdownCross by remember { mutableStateOf(false) }
    var trendCost by remember { mutableStateOf(false) }
    var trendMonthly by remember { mutableStateOf(false) }
    val period = snapshot?.period(state.period)
    val summary = snapshot?.history
    val rise = with(LocalDensity.current) { 8.dp.roundToPx() }
    val fade = motionTween<Float>(Motion.PageMs)
    val shift = motionTween<androidx.compose.ui.unit.IntOffset>(Motion.PageMs)
    AnimatedContent(
        targetState = pane,
        modifier = Modifier.fillMaxSize(),
        transitionSpec = {
            ((fadeIn(fade) + slideInVertically(shift) { rise }) togetherWith
                (fadeOut(fade) + slideOutVertically(shift) { -rise }))
                .using(SizeTransform(clip = false))
        },
        label = "analysis"
    ) { current ->
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = pageContentPadding(),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item {
                PageHeader(stringResource(R.string.nav_analysis), { DeviceStatus(snapshot) }, onSettings)
                ChoiceRow(
                    listOf(AnalysisPane.Overview to R.string.dash_overview, AnalysisPane.Trends to R.string.dash_trends),
                    current
                ) { pane = it }
            }
            item { FailureText(state.failure) }
            if (snapshot == null || (summary == null && snapshot.daily.isEmpty())) {
                item { Text(stringResource(R.string.empty_history), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            } else if (current == AnalysisPane.Overview) {
                overviewItems(snapshot, summary, period, state, onPeriod, shareByTool, breakdownCross, { shareByTool = it }, { breakdownCross = it })
            } else {
                trendItems(snapshot, trendCost, trendMonthly, { trendCost = it }, { trendMonthly = it })
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.overviewItems(
    snapshot: StatsSnapshot,
    summary: HistorySummary?,
    period: com.javis.tokenmonitor.remote.core.PeriodSummary?,
    state: UiState,
    onPeriod: (PeriodId) -> Unit,
    shareByTool: Boolean,
    breakdownCross: Boolean,
    onShare: (Boolean) -> Unit,
    onBreakdown: (Boolean) -> Unit
) {
    if (summary != null) {
        item { HistoryCards(summary) }
    }
    if (snapshot.daily.any { it.tokens != null }) {
        item { Text(stringResource(R.string.dash_trends), style = MaterialTheme.typography.titleMedium) }
        item {
            GraphitePanel {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ValueBars(snapshot.daily.map { ChartBar(it.tokens?.toFloat(), dayLabel(it.date)) })
                    RangeCaption(dayLabel(snapshot.daily.first().date), dayLabel(snapshot.daily.last().date))
                }
            }
        }
    }
    val weekdays = weekdayBuckets(snapshot.daily)
    if (weekdays.any { it.second > 0L }) {
        item { Text(stringResource(R.string.by_weekday), style = MaterialTheme.typography.titleMedium) }
        item {
            GraphitePanel {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    ValueBars(weekdays.map { ChartBar(it.second.toFloat(), it.first) }, showAxis = true)
                }
            }
        }
    }
    item { Text(stringResource(R.string.share_title), style = MaterialTheme.typography.titleMedium) }
    item {
        ChoiceRow(listOf(true to R.string.by_tool, false to R.string.by_model), shareByTool, onShare)
    }
    item { PeriodControl(state.period, onPeriod) }
    item(key = "share-body") {
        val swap = fadeIn(motionTween(Motion.PageMs)) togetherWith fadeOut(motionTween(Motion.FadeMs))
        AnimatedContent(
            targetState = shareByTool,
            transitionSpec = { swap },
            label = "share"
        ) { byTool ->
            val rows = (if (byTool) period?.clients else period?.models).orEmpty().filter { it.tokens > 0 }.take(5)
            val total = period?.totalTokens ?: 0L
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (rows.isEmpty()) {
                    Text(stringResource(R.string.empty_history), color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    rows.forEach { row -> UsageAmountRow(usageLabel(row.id, !byTool), row.tokens, total) }
                }
            }
        }
    }
    item {
        ChoiceRow(
            listOf(false to R.string.breakdown_lists, true to R.string.analysis_cross),
            breakdownCross,
            onBreakdown
        )
    }
    item(key = "breakdown-body") {
        val swap = fadeIn(motionTween(Motion.PageMs)) togetherWith fadeOut(motionTween(Motion.FadeMs))
        AnimatedContent(
            targetState = breakdownCross,
            transitionSpec = { swap },
            label = "breakdown"
        ) { cross ->
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (!cross) {
                    RankedBlock(R.string.by_tool, period?.clients.orEmpty(), period?.totalTokens ?: 0L, false)
                    RankedBlock(R.string.by_model, period?.models.orEmpty(), period?.totalTokens ?: 0L, true)
                } else {
                    val groups = period?.toolModels.orEmpty()
                    if (groups.isEmpty()) {
                        Text(stringResource(R.string.empty_models), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        groups.forEach { group ->
                            Text(providerName(group.toolId), style = MaterialTheme.typography.titleMedium)
                            val toolTotal = group.models.sumOf { it.tokens }
                            group.models.forEach { model ->
                                UsageAmountRow(usageLabel(model.id, true), model.tokens, toolTotal)
                            }
                        }
                    }
                }
            }
        }
    }
    item { Text(stringResource(R.string.devices_tile), style = MaterialTheme.typography.titleMedium) }
    val devices = snapshot.devices.sortedWith(
        compareByDescending<com.javis.tokenmonitor.remote.core.DeviceSummary> { it.tokens(state.period) }.thenBy { it.hostname }
    )
    if (devices.isEmpty()) {
        item { Text(stringResource(R.string.empty_devices), color = MaterialTheme.colorScheme.onSurfaceVariant) }
    } else {
        items(devices, key = { it.deviceId }) { device ->
            DeviceRow(device, state.period)
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.trendItems(
    snapshot: StatsSnapshot,
    cost: Boolean,
    monthly: Boolean,
    onCost: (Boolean) -> Unit,
    onMonthly: (Boolean) -> Unit
) {
    item { ChoiceRow(listOf(false to R.string.metric_tokens, true to R.string.metric_cost), cost, onCost) }
    item { ChoiceRow(listOf(false to R.string.group_day, true to R.string.group_month), monthly, onMonthly) }
    item {
        GraphitePanel {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (monthly) {
                    ValueBars(
                        snapshot.monthly.map { ChartBar(if (cost) it.costUsd.toFloat() else it.tokens.toFloat(), it.month) },
                        money = cost
                    )
                    if (snapshot.monthly.isNotEmpty()) RangeCaption(snapshot.monthly.first().month, snapshot.monthly.last().month)
                } else {
                    ValueBars(
                        snapshot.daily.map {
                            ChartBar(if (cost) it.costUsd?.toFloat() else it.tokens?.toFloat(), dayLabel(it.date))
                        },
                        money = cost
                    )
                    if (snapshot.daily.isNotEmpty()) RangeCaption(dayLabel(snapshot.daily.first().date), dayLabel(snapshot.daily.last().date))
                }
            }
        }
    }
}

@Composable
private fun RankedBlock(title: Int, rows: List<ClientUsage>, total: Long, model: Boolean) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(title), style = MaterialTheme.typography.titleMedium)
        val visible = rows.filter { it.tokens > 0 }.take(6)
        if (visible.isEmpty()) {
            Text(stringResource(R.string.empty_history), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            visible.forEach { row -> UsageAmountRow(usageLabel(row.id, model), row.tokens, total) }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.rankedRows(
    title: Int,
    rows: List<ClientUsage>,
    total: Long,
    model: Boolean,
    keyPrefix: String
) {
    item { Text(stringResource(title), style = MaterialTheme.typography.titleMedium) }
    val visible = rows.filter { it.tokens > 0 }.take(6)
    if (visible.isEmpty()) {
        item { Text(stringResource(R.string.empty_history), color = MaterialTheme.colorScheme.onSurfaceVariant) }
    } else {
        items(visible, key = { "$keyPrefix:${it.id}" }) { row ->
            UsageAmountRow(usageLabel(row.id, model), row.tokens, total)
        }
    }
}

@Composable
private fun <T> ChoiceRow(options: List<Pair<T, Int>>, selected: T, onSelect: (T) -> Unit) {
    val index = options.indexOfFirst { it.first == selected }.coerceAtLeast(0)
    SoftGlass(Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(24.dp), corner = 24.dp, veil = 1f, blur = true) {
        SelectionCapsule(
            selected = index,
            count = options.size,
            color = selectionThumb(),
            modifier = Modifier.fillMaxSize().padding(4.dp)
        ) {
            Row(Modifier.fillMaxSize()) {
                options.forEach { (id, label) ->
                    val on = selected == id
                    val color by animateColorAsState(
                        targetValue = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                        animationSpec = motionTween(Motion.FadeMs),
                        label = "choice"
                    )
                    Box(
                        Modifier.weight(1f).fillMaxSize().clickable(remember { MutableInteractionSource() }, null) { onSelect(id) },
                        contentAlignment = Alignment.Center
                    ) {
                        Text(
                            stringResource(label),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            color = color,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun HistoryCards(summary: HistorySummary) {
    val cards = listOf(
        R.string.stat_total_tokens to null,
        R.string.stat_total_cost to Format.costUsd(summary.costUsd),
        R.string.stat_active_days to summary.activeDays.toString(),
        R.string.stat_streak to summary.currentStreak.toString(),
        R.string.stat_peak to null,
        R.string.stat_favorite_model to summary.favoriteModel.ifBlank { "—" },
        R.string.stat_messages to Format.groupedTokens(summary.messages),
        R.string.stat_active_time to formatDuration(summary.activeTimeMs)
    )
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        cards.chunked(2).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                row.forEach { (label, value) ->
                    GraphitePanel(Modifier.weight(1f)) {
                        Column(Modifier.padding(16.dp)) {
                            Text(stringResource(label), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (label == R.string.stat_total_tokens) {
                                FittedTokens(summary.totalTokens, MaterialTheme.typography.titleLarge, LocalGraphiteExtraColors.current.metricNumber, Modifier.fillMaxWidth())
                            } else if (label == R.string.stat_peak) {
                                FittedTokens(summary.peakDayTokens, MaterialTheme.typography.titleLarge, LocalGraphiteExtraColors.current.metricNumber, Modifier.fillMaxWidth())
                            } else {
                                val prose = label == R.string.stat_favorite_model || label == R.string.stat_active_time
                                val style = if (prose) {
                                    MaterialTheme.typography.titleLarge.copy(fontFamily = FontFamily.Default)
                                } else {
                                    MaterialTheme.typography.titleLarge
                                }
                                FittedLine(
                                    value.orEmpty(),
                                    style,
                                    LocalGraphiteExtraColors.current.metricNumber,
                                    Modifier.fillMaxWidth()
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private data class ChartBar(val value: Float?, val caption: String)

@Composable
private fun ValueBars(bars: List<ChartBar>, money: Boolean = false, showAxis: Boolean = false) {
    if (bars.isEmpty()) return
    val extra = LocalGraphiteExtraColors.current
    val peak = bars.maxOf { it.value ?: 0f }.takeIf { it > 0f } ?: 1f
    var selected by remember(bars.size, bars.firstOrNull()?.caption, bars.lastOrNull()?.caption, money) {
        mutableIntStateOf(bars.indexOfLast { (it.value ?: 0f) > 0f }.coerceAtLeast(0))
    }
    val current = bars[selected.coerceIn(0, bars.lastIndex)]
    val readout = when (val amount = current.value) {
        null -> "—"
        else -> if (money) Format.costUsd(amount.toDouble()) else Format.compactTokens(amount.toLong())
    }
    val haptic = LocalHapticFeedback.current
    val tick = if (bars.size > 12) HapticFeedbackType.SegmentFrequentTick else HapticFeedbackType.SegmentTick
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(current.caption, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f), maxLines = 1)
            RollingText(readout, style = MaterialTheme.typography.bodyMedium.copy(fontWeight = FontWeight.SemiBold), color = extra.metricNumber)
        }
        Row(
            Modifier
                .fillMaxWidth()
                .height(if (showAxis) 112.dp else 88.dp)
                .pointerInput(bars.size, tick) {
                    val slop = viewConfiguration.touchSlop
                    fun select(x: Float) {
                        if (bars.isEmpty() || size.width <= 0) return
                        val next = (x / size.width * bars.size).toInt().coerceIn(0, bars.lastIndex)
                        if (next == selected) return
                        selected = next
                        haptic.performHapticFeedback(tick)
                    }
                    awaitEachGesture {
                        val down = awaitFirstDown()
                        val origin = down.position
                        var scrubbing = false
                        while (true) {
                            val event = awaitPointerEvent()
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) {
                                if (!scrubbing) select(change.position.x)
                                break
                            }
                            val dx = change.position.x - origin.x
                            val dy = change.position.y - origin.y
                            if (!scrubbing) {
                                if (kotlin.math.abs(dy) > slop && kotlin.math.abs(dy) > kotlin.math.abs(dx)) break
                                if (kotlin.math.abs(dx) > slop) scrubbing = true
                            }
                            if (scrubbing) {
                                select(change.position.x)
                                change.consume()
                            }
                        }
                    }
                },
            verticalAlignment = Alignment.Bottom
        ) {
            bars.forEachIndexed { index, bar ->
                val target = when (val amount = bar.value) {
                    null -> 0f
                    else -> if (amount <= 0f) 0.06f else (amount / peak).coerceIn(0.08f, 1f)
                }
                val fraction by animateFloatAsState(
                    targetValue = target,
                    animationSpec = motionTween(Motion.MeterMs),
                    label = "bar$index"
                )
                val on = index == selected
                Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(Modifier.fillMaxWidth().padding(horizontal = 1.dp).weight(1f), contentAlignment = Alignment.BottomCenter) {
                        if (bar.value != null) {
                            Box(
                                Modifier
                                    .fillMaxWidth()
                                    .fillMaxHeight(fraction)
                                    .clip(RoundedCornerShape(3.dp))
                                    .background(
                                        when {
                                            on -> extra.chartPrimary
                                            (bar.value) <= 0f -> extra.progressTrack
                                            else -> extra.chartPrimary.copy(alpha = 0.38f)
                                        }
                                    )
                            )
                        }
                    }
                    if (showAxis) {
                        Text(
                            bar.caption,
                            style = MaterialTheme.typography.bodySmall,
                            color = if (on) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                            fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                            maxLines = 1
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun RangeCaption(start: String, end: String) {
    Row(Modifier.fillMaxWidth()) {
        Text(start, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.weight(1f))
        Text(end, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DeviceRow(device: com.javis.tokenmonitor.remote.core.DeviceSummary, period: PeriodId) {
    val extra = LocalGraphiteExtraColors.current
    GraphitePanel {
        BoxWithConstraints(Modifier.fillMaxWidth().padding(16.dp)) {
            val rowWidth = maxWidth
            Row(Modifier.heightIn(min = 64.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(device.hostname, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val age = device.ageMs?.let { ageText(it) }
                    val status = if (device.stale) {
                        listOfNotNull(stringResource(R.string.stale), age).joinToString(" · ")
                    } else {
                        stringResource(R.string.live)
                    }
                    Text(status, style = MaterialTheme.typography.bodySmall, color = if (device.stale) MaterialTheme.colorScheme.error else extra.success)
                }
                FittedTokens(
                    device.tokens(period),
                    MaterialTheme.typography.titleLarge,
                    extra.metricNumber,
                    Modifier.padding(start = 12.dp).widthIn(max = rowWidth * 0.55f)
                )
            }
        }
    }
}

@Composable
private fun usageLabel(id: String, model: Boolean): String {
    if (id == UNATTRIBUTED_ID) return stringResource(R.string.unattributed)
    return if (model) id else providerName(id)
}

@Composable
private fun formatDuration(ms: Long): String {
    val minutes = (ms / 60_000L).toInt()
    val hours = minutes / 60
    val remain = minutes % 60
    return when {
        hours <= 0 -> stringResource(R.string.duration_minutes, minutes.coerceAtLeast(0))
        remain == 0 -> stringResource(R.string.duration_hours, hours)
        else -> stringResource(R.string.duration_hours_minutes, hours, remain)
    }
}

private fun weekdayBuckets(daily: List<DayUsage>): List<Pair<String, Long>> {
    val locale = Locale.getDefault()
    val first = WeekFields.of(locale).firstDayOfWeek
    val totals = LongArray(7)
    for (day in daily) {
        val tokens = day.tokens ?: continue
        val date = runCatching { LocalDate.parse(day.date) }.getOrNull() ?: continue
        val index = Math.floorMod(date.dayOfWeek.value - first.value, 7)
        totals[index] += tokens
    }
    return (0 until 7).map { offset ->
        val day = DayOfWeek.of(((first.value - 1 + offset) % 7) + 1)
        day.getDisplayName(java.time.format.TextStyle.NARROW, locale) to totals[offset]
    }
}

private fun dayLabel(date: String): String {
    val parts = date.split("-")
    if (parts.size == 2) return "${parts[1].toIntOrNull() ?: return date}"
    val month = parts.getOrNull(1)?.toIntOrNull() ?: return date
    val day = parts.getOrNull(2)?.toIntOrNull() ?: return date
    return "$month/$day"
}

@Composable
private fun UsageAmountRow(name: String, tokens: Long, total: Long) {
    val extra = LocalGraphiteExtraColors.current
    val numberStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium)
    GraphitePanel {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            BoxWithConstraints(Modifier.fillMaxWidth()) {
                val rowWidth = maxWidth
                val gap = 12.dp
                val nameStyle = MaterialTheme.typography.bodyMedium
                val grouped = Format.groupedTokens(tokens)
                val groupedWidth = textWidth(grouped, numberStyle)
                val nameWidth = textWidth(name, nameStyle)
                val numberText = if (nameWidth + gap + groupedWidth <= rowWidth) grouped else Format.compactTokens(tokens)
                val numberWidth = if (numberText == grouped) groupedWidth else textWidth(numberText, numberStyle)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        name,
                        modifier = Modifier.widthIn(max = (rowWidth - numberWidth - gap).coerceAtLeast(48.dp)),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        style = nameStyle
                    )
                    Spacer(Modifier.weight(1f))
                    Text(
                        numberText,
                        style = numberStyle,
                        color = extra.metricNumber,
                        maxLines = 1,
                        softWrap = false,
                        overflow = TextOverflow.Clip
                    )
                }
            }
            ShareBar(tokens, total)
        }
    }
}

@Composable
private fun ShareBar(tokens: Long, total: Long) {
    val extra = LocalGraphiteExtraColors.current
    val fraction = if (total <= 0L) 0f else (tokens.toFloat() / total.toFloat()).coerceIn(0f, 1f)
    val width by animateFloatAsState(
        targetValue = fraction,
        animationSpec = motionTween(Motion.MeterMs),
        label = "share"
    )
    Box(Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(999.dp)).background(extra.progressTrack)) {
        Box(Modifier.fillMaxWidth(width).fillMaxHeight().background(extra.chartPrimary))
    }
}

@Composable
private fun FittedLine(
    text: String,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    minFontSize: TextUnit = 13.sp
) {
    BoxWithConstraints(modifier) {
        val limit = maxWidth
        val measurer = rememberTextMeasurer()
        val density = LocalDensity.current
        val base = if (style.fontSize != TextUnit.Unspecified) style.fontSize.value else 22f
        val floor = minFontSize.value.coerceIn(1f, base)
        val fit = remember(text, style, base, floor, density.density, density.fontScale, limit) {
            fun widthOf(sizeSp: Float): Float {
                val px = measurer.measure(
                    text,
                    style = style.copy(fontSize = sizeSp.sp, lineHeight = TextUnit.Unspecified),
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Clip
                ).size.width
                return px / density.density
            }
            val budget = if (limit.value.isFinite()) (limit.value - 1f).coerceAtLeast(0f) else Float.POSITIVE_INFINITY
            when {
                widthOf(base) <= budget -> base
                widthOf(floor) > budget -> floor
                else -> {
                    var low = floor
                    var high = base
                    while (high - low > 0.5f) {
                        val mid = (low + high) / 2f
                        if (widthOf(mid) <= budget) low = mid else high = mid
                    }
                    low
                }
            }
        }
        Text(
            text,
            modifier = Modifier.fillMaxWidth(),
            style = style.copy(fontSize = fit.sp),
            color = color,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun FittedTokens(
    value: Long,
    style: TextStyle,
    color: Color,
    modifier: Modifier = Modifier,
    roll: Boolean = false
) {
    BoxWithConstraints(modifier) {
        val limit = maxWidth
        val grouped = Format.groupedTokens(value)
        val compact = Format.compactTokens(value)
        val figure = when {
            !limit.value.isFinite() -> grouped
            textWidth(grouped, style) <= limit -> grouped
            else -> compact
        }
        if (roll) {
            RollingText(figure, style = style, color = color, modifier = Modifier.fillMaxWidth())
        } else {
            Text(
                figure,
                modifier = Modifier.fillMaxWidth(),
                style = style,
                color = color,
                maxLines = 1,
                softWrap = false,
                overflow = TextOverflow.Clip
            )
        }
    }
}

@Composable
private fun textWidth(text: String, style: TextStyle): Dp {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val px = remember(text, style, density.density, density.fontScale) {
        measurer.measure(text, style = style, maxLines = 1, softWrap = false).size.width
    }
    return with(density) { px.toDp() }
}

@Composable
private fun DeviceStatus(snapshot: StatsSnapshot?) {
    val extra = LocalGraphiteExtraColors.current
    val devices = snapshot?.devices.orEmpty()
    val live = devices.filter { !it.stale }
    val color: Color
    val text: String
    when {
        devices.isEmpty() -> {
            color = MaterialTheme.colorScheme.error
            text = stringResource(R.string.devices_none)
        }
        live.isEmpty() -> {
            color = extra.warning
            text = stringResource(R.string.devices_offline)
        }
        devices.size == 1 -> {
            color = extra.success
            text = stringResource(R.string.device_online, live.single().hostname)
        }
        else -> {
            color = extra.success
            text = stringResource(R.string.devices_online_count, live.size)
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(8.dp).background(color, CircleShape))
        Spacer(Modifier.size(6.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun PinWidgets() {
    val context = LocalContext.current
    val manager = AppWidgetManager.getInstance(context)
    if (!manager.isRequestPinAppWidgetSupported) return
    val sizes = listOf(
        R.string.widget_1x2_name to Widget1x2Receiver::class.java,
        R.string.widget_2x1_name to Widget2x1Receiver::class.java,
        R.string.widget_2x2_name to Widget2x2Receiver::class.java,
        R.string.widget_4x2_name to Widget4x2Receiver::class.java
    )
    GraphitePanel {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(stringResource(R.string.pin_widgets), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.pin_widgets_note), style = MaterialTheme.typography.bodySmall)
            sizes.forEach { (label, receiver) ->
                Text(
                    stringResource(label),
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = 44.dp)
                        .clickable(remember { MutableInteractionSource() }, null) {
                            manager.requestPinAppWidget(ComponentName(context, receiver), null, null)
                        }
                        .padding(vertical = 10.dp)
                )
            }
        }
    }
}

@Composable
private fun IslandSwitch(enabled: Boolean, onChange: (Boolean) -> Unit) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) onChange(true)
    }
    GraphitePanel {
        Row(
            Modifier.fillMaxWidth().padding(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            Column(Modifier.weight(1f).padding(end = 12.dp)) {
                Text(stringResource(R.string.island_title), style = MaterialTheme.typography.titleMedium)
                Text(stringResource(R.string.island_body), style = MaterialTheme.typography.bodySmall)
            }
            GlassSwitch(enabled) { want ->
                if (!want) {
                    onChange(false)
                    return@GlassSwitch
                }
                val needsPermission = Build.VERSION.SDK_INT >= 33 &&
                    ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
                if (needsPermission) launcher.launch(Manifest.permission.POST_NOTIFICATIONS) else onChange(true)
            }
        }
    }
}

@Composable
private fun FailureText(failure: HubFailure?) {
    val message = failureMessage(failure)
    AnimatedVisibility(
        visible = message != null,
        enter = fadeIn(motionTween(Motion.FadeMs)),
        exit = fadeOut(motionTween(Motion.FadeMs))
    ) {
        Text(message.orEmpty(), color = MaterialTheme.colorScheme.error)
    }
}

@Composable
private fun failureMessage(failure: HubFailure?): String? = when (failure) {
    null -> null
    HubFailure.Unreachable -> stringResource(R.string.failure_unreachable)
    HubFailure.Unauthorized -> stringResource(R.string.failure_unauthorized)
    HubFailure.SecretRequired -> stringResource(R.string.failure_secret_required)
    HubFailure.HubStopping -> stringResource(R.string.failure_stopping)
    HubFailure.Malformed -> stringResource(R.string.failure_malformed)
}

@Composable
private fun connectMessage(result: ConnectResult?): String? = when (result) {
    null, ConnectResult.Connected -> null
    ConnectResult.InvalidUrl -> stringResource(R.string.invalid_url)
    ConnectResult.MissingSecret -> stringResource(R.string.missing_secret)
    is ConnectResult.Rejected -> failureMessage(result.failure)
    is ConnectResult.StoreFailed -> stringResource(R.string.store_failed)
}

@Composable
private fun statusText(status: String): String? {
    val id = when (status) {
        "", "ok" -> return null
        "unauthorized" -> R.string.status_unauthorized
        "rateLimited", "sourceRateLimited" -> R.string.status_rate_limited
        "unavailable" -> R.string.status_unavailable
        "notConfigured" -> R.string.status_not_configured
        "disabled" -> R.string.status_disabled
        else -> R.string.status_error
    }
    return stringResource(id)
}

@Composable
private fun ageText(ageMs: Long): String {
    val minutes = ageMs / 60_000
    return when {
        minutes < 1 -> stringResource(R.string.age_now)
        minutes < 60 -> stringResource(R.string.age_minutes, minutes.toInt())
        minutes < 60 * 48 -> stringResource(R.string.age_hours, (minutes / 60).toInt())
        else -> stringResource(R.string.age_days, (minutes / (60 * 24)).toInt())
    }
}

internal fun providerName(id: String): String =
    id.replaceFirstChar { if (it.isLowerCase()) it.titlecase(Locale.getDefault()) else it.toString() }

private fun formatInstant(iso: String): String? = try {
    val instant = Instant.parse(iso)
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(instant)
} catch (_: Exception) {
    null
}
