package com.javis.tokenmonitor.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.Button
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.javis.tokenmonitor.ConnectionStatus
import com.javis.tokenmonitor.R
import com.javis.tokenmonitor.data.GatewayEndpoint
import com.javis.tokenmonitor.data.LimitWindow
import com.javis.tokenmonitor.data.Limits
import com.javis.tokenmonitor.data.Period
import com.javis.tokenmonitor.data.StatsResponse

// Beyond this a breakdown becomes a scroll inside a scroll, and the tail is
// long-tail models nobody is watching.
private const val MAX_BREAKDOWN_ROWS = 8

/**
 * The dashboard. `endpoint` is nullable because this screen is reachable before
 * anything is selected (the Overview tab with no gateway), in which case it
 * shows a prompt that routes the user to the list rather than an empty shell.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DashboardScreen(
    endpoint: GatewayEndpoint?,
    stats: StatsResponse?,
    status: ConnectionStatus,
    onSwitchToGateways: () -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier
) {
    if (endpoint == null) {
        EmptyOverview(onSwitchToGateways = onSwitchToGateways, modifier = modifier)
        return
    }

    // Saveable so rotating the phone does not throw the user back to Today.
    var periodKey by rememberSaveable { mutableStateOf("today") }

    Scaffold(
        modifier = modifier,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            text = endpoint.label,
                            style = MaterialTheme.typography.titleMedium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp)
                        ) {
                            StatusDot(status)
                            Text(
                                text = statusLabel(status),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.action_refresh))
                    }
                }
            )
        }
    ) { padding ->
        val current = stats
        if (current == null) {
            EmptyState(
                endpoint = endpoint,
                status = status,
                onSwitchToGateways = onSwitchToGateways,
                onRefresh = onRefresh,
                modifier = Modifier.padding(padding)
            )
        } else {
            DashboardContent(
                stats = current,
                periodKey = periodKey,
                onPeriodChange = { periodKey = it },
                onRefresh = onRefresh,
                modifier = Modifier.padding(padding)
            )
        }
    }
}

/** Shown on the Overview tab when no gateway is selected yet. */
@Composable
private fun EmptyOverview(onSwitchToGateways: () -> Unit, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Icon(
                Icons.Outlined.Storage,
                contentDescription = null,
                modifier = Modifier.size(48.dp),
                tint = MaterialTheme.colorScheme.primary
            )
            Text(
                text = stringResource(R.string.overview_empty_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = stringResource(R.string.overview_empty_body),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Button(onClick = onSwitchToGateways) {
                Text(stringResource(R.string.overview_empty_action))
            }
        }
    }
}

/**
 * Shown when a gateway is selected but there is nothing to display, which
 * includes every failure. It names the address being tried and offers a way out
 * that does not depend on spotting the bottom tab.
 */
@Composable
private fun EmptyState(
    endpoint: GatewayEndpoint,
    status: ConnectionStatus,
    onSwitchToGateways: () -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier
) {
    val failed = status is ConnectionStatus.Failed
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        ElevatedCard(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp)
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Text(
                    text = statusLabel(status),
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (failed) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = endpoint.baseUrl,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                if (failed) {
                    Text(
                        text = stringResource(R.string.empty_state_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = onSwitchToGateways) {
                        Text(stringResource(R.string.action_switch))
                    }
                    OutlinedButton(onClick = onRefresh) {
                        Text(stringResource(R.string.action_refresh))
                    }
                }
            }
        }
    }
}

@Composable
private fun DashboardContent(
    stats: StatsResponse,
    periodKey: String,
    onPeriodChange: (String) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier
) {
    val period = stats.periods[periodKey]
    LazyColumn(
        modifier = modifier.fillMaxSize(),
        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        item { ConnectionBanner(stats, onRefresh) }
        item { PeriodSelector(periodKey, onPeriodChange) }
        item { OverviewCard(stats, period) }

        if (period != null && period.clients.isNotEmpty()) {
            item { BreakdownCard(stringResource(R.string.section_tools), period.clients, period.clientCosts) }
        }
        if (period != null && period.models.isNotEmpty()) {
            item { BreakdownCard(stringResource(R.string.section_models), period.models, period.modelCosts) }
        }
        if (stats.limits.providers.isNotEmpty()) {
            item { LimitsCard(stats.limits) }
        }
        if (stats.devices.isNotEmpty()) {
            item { DevicesCard(stats, periodKey) }
        }
    }
}

/** A single status strip at the top of the dashboard: live/failed + age + retry. */
@Composable
private fun ConnectionBanner(stats: StatsResponse, onRefresh: () -> Unit) {
    // The snapshot is top-level; a gateway whose stream broke keeps showing the
    // last good reading, so age is measured from the snapshot, not the stream.
    val color = when (stats.source) {
        "gateway" -> MaterialTheme.colorScheme.primary
        else -> MaterialTheme.colorScheme.tertiary
    }
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Box(modifier = Modifier.size(10.dp).clip(CircleShape).background(color))
            Column(Modifier.weight(1f)) {
                Text(
                    text = stringResource(R.string.status_connected),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
                stats.updatedAt?.let {
                    Text(
                        text = stringResource(R.string.overview_updated, formatRelative(it)),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            OutlinedButton(onClick = onRefresh) {
                Text(stringResource(R.string.conn_retry))
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PeriodSelector(selected: String, onSelect: (String) -> Unit) {
    val options = listOf(
        "today" to stringResource(R.string.period_today),
        "month" to stringResource(R.string.period_month),
        "allTime" to stringResource(R.string.period_all)
    )
    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
        options.forEachIndexed { index, (key, label) ->
            SegmentedButton(
                selected = key == selected,
                onClick = { onSelect(key) },
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size)
            ) {
                Text(label)
            }
        }
    }
}

@Composable
private fun OverviewCard(stats: StatsResponse, period: Period?) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(
                    text = stringResource(R.string.overview_tokens),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                stats.updatedAt?.let {
                    Text(
                        text = stringResource(R.string.overview_updated, formatRelative(it)),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            Text(
                text = formatTokens(period?.totalTokens ?: 0.0),
                style = MaterialTheme.typography.displaySmall,
                fontWeight = FontWeight.Bold
            )
            HorizontalDivider()
            Row(Modifier.fillMaxWidth()) {
                val live = stats.devices.count { !it.stale }
                StatCell(stringResource(R.string.overview_cost), formatCost(period?.costUsd), Modifier.weight(1f))
                StatCell(stringResource(R.string.overview_devices), "$live / ${stats.deviceCount}", Modifier.weight(1f))
                val top = period?.clients?.maxByOrNull { it.value }?.key
                if (top != null) {
                    StatCell(stringResource(R.string.overview_top), formatLabel(top), Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun StatCell(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun BreakdownCard(title: String, tokens: Map<String, Double>, costs: Map<String, Double>) {
    val rows = tokens.entries.sortedByDescending { it.value }.take(MAX_BREAKDOWN_ROWS)
    val maximum = rows.firstOrNull()?.value ?: 0.0
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            rows.forEachIndexed { index, (key, value) ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            text = "${index + 1}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline,
                            modifier = Modifier.width(20.dp)
                        )
                        Text(
                            text = formatLabel(key),
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Text(
                            text = formatTokens(value),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(
                            text = formatCost(costs[key]),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    UsageBar(if (maximum > 0) (value / maximum).toFloat() else 0f)
                }
            }
        }
    }
}

@Composable
private fun LimitsCard(limits: Limits) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp)
        ) {
            Text(stringResource(R.string.section_limits), style = MaterialTheme.typography.titleSmall)
            if (limits.providers.isEmpty()) {
                Text(
                    text = stringResource(R.string.limits_empty),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            limits.providers.forEach { provider ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(
                            text = formatLabel(provider.provider),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold
                        )
                        provider.status?.let {
                            Text(
                                text = it,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    provider.windows.forEach { window -> LimitWindowRow(window) }
                }
            }
        }
    }
}

@Composable
private fun LimitWindowRow(window: LimitWindow) {
    val usedPercent = window.usedPercent
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(
                text = window.label?.takeIf { it.isNotBlank() } ?: formatLabel(window.kind ?: "window"),
                style = MaterialTheme.typography.bodySmall
            )
            Text(
                text = if (window.isMoney) formatMoney(window.remaining ?: window.limit, window.currency)
                else formatPercent(usedPercent),
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium
            )
        }
        if (!window.isMoney && usedPercent != null) {
            UsageBar((usedPercent / 100.0).toFloat(), MaterialTheme.colorScheme.tertiary)
        }
        val resets = formatReset(window.resetsAt)
        if (resets.isNotBlank()) {
            Text(
                text = stringResource(R.string.limits_resets, resets),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun DevicesCard(stats: StatsResponse, periodKey: String) {
    ElevatedCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(stringResource(R.string.section_devices), style = MaterialTheme.typography.titleSmall)
            stats.devices.forEach { device ->
                val period = device.periods[periodKey]
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = device.displayName,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            DeviceStatusDot(device.stale)
                            if (device.platformLabel.isNotBlank()) {
                                Text(
                                    text = device.platformLabel,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                            Text(
                                text = stringResource(if (device.stale) R.string.device_offline else R.string.device_online),
                                style = MaterialTheme.typography.labelSmall,
                                color = if (device.stale) MaterialTheme.colorScheme.error
                                else MaterialTheme.colorScheme.primary
                            )
                        }
                        device.updatedAt?.let {
                            Text(
                                text = stringResource(R.string.overview_updated, formatRelative(it)),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            text = formatTokens(period?.totalTokens ?: 0.0),
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold
                        )
                        Text(
                            text = formatCost(period?.costUsd),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun UsageBar(fraction: Float, color: Color = MaterialTheme.colorScheme.primary) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(6.dp)
            .clip(RoundedCornerShape(3.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth(fraction.coerceIn(0f, 1f))
                .fillMaxHeight()
                .background(color)
        )
    }
}

@Composable
private fun StatusDot(status: ConnectionStatus) {
    val color = when (status) {
        ConnectionStatus.Connected -> MaterialTheme.colorScheme.primary
        is ConnectionStatus.Failed -> MaterialTheme.colorScheme.error
        else -> MaterialTheme.colorScheme.outline
    }
    Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(color))
}

@Composable
private fun DeviceStatusDot(stale: Boolean) {
    val color = if (stale) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(color))
}

@Composable
private fun statusLabel(status: ConnectionStatus): String = when (status) {
    ConnectionStatus.Idle -> stringResource(R.string.gateways_empty)
    ConnectionStatus.Connecting -> stringResource(R.string.status_connecting)
    ConnectionStatus.Reconnecting -> stringResource(R.string.status_reconnecting)
    ConnectionStatus.Connected -> stringResource(R.string.status_connected)
    is ConnectionStatus.Failed -> status.message.ifBlank { stringResource(R.string.status_reconnecting) }
}
