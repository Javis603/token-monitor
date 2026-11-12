package com.javis.tokenmonitor.remote.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.javis.tokenmonitor.remote.R
import com.javis.tokenmonitor.remote.core.DiscoveredHub
import com.javis.tokenmonitor.remote.core.HubLinkBinding
import com.javis.tokenmonitor.remote.data.LinkPairResult

/**
 * "Pair desktop" flow: nearby hubs from mDNS, the 6-digit code shown on the desktop, and the
 * `tokenmonitor://pair` link as an alternative. Discovery runs while the panel is on screen.
 */
@Composable
internal fun PairingPanel(
    nearby: List<DiscoveredHub>,
    discovering: Boolean,
    selectedHubId: String?,
    busy: Boolean,
    result: LinkPairResult?,
    onSelectHub: (String) -> Unit,
    onPairCode: (String) -> Unit,
    onPairLink: (String) -> Unit,
    onStartPairing: () -> Unit,
    onStopPairing: () -> Unit
) {
    var code by remember { mutableStateOf("") }
    var linkDraft by remember { mutableStateOf("") }
    LaunchedEffect(Unit) { onStartPairing() }
    DisposableEffect(Unit) {
        onDispose { onStopPairing() }
    }
    GraphitePanel {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(stringResource(R.string.pair_title), style = MaterialTheme.typography.titleMedium)
            Text(stringResource(R.string.pair_body), style = MaterialTheme.typography.bodySmall)
            Text(
                stringResource(R.string.nearby_devices),
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            when {
                nearby.isEmpty() && discovering -> Text(
                    stringResource(R.string.nearby_searching),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                nearby.isEmpty() -> Text(
                    stringResource(R.string.nearby_none),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                else -> nearby.forEach { hub ->
                    NearbyHubRow(hub, hub.hubId == selectedHubId) { onSelectHub(hub.hubId) }
                }
            }
            GlassField(
                value = code,
                onValueChange = { value -> code = value.filter(Char::isDigit).take(6) },
                label = stringResource(R.string.pairing_code),
                placeholder = stringResource(R.string.pairing_code_hint)
            )
            CapsuleButton(
                stringResource(R.string.pair_action),
                enabled = !busy && selectedHubId != null && code.length == 6
            ) { onPairCode(code) }
            GlassField(
                value = linkDraft,
                onValueChange = { linkDraft = it },
                label = stringResource(R.string.paste_pairing_link)
            )
            CapsuleButton(
                stringResource(R.string.pair_from_link),
                enabled = !busy && linkDraft.isNotBlank()
            ) { onPairLink(linkDraft.trim()) }
            pairingMessage(result)?.let { message ->
                Text(message, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/** Linked state: the binding is passive, stats reconnect automatically when discovery finds it. */
@Composable
internal fun LinkedPanel(
    binding: HubLinkBinding,
    busy: Boolean,
    onForget: () -> Unit
) {
    GraphitePanel {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(stringResource(R.string.device_link), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.linked_to, binding.hubName),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.primary
            )
            binding.candidates.firstOrNull()?.let { address ->
                Text(
                    address,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            QuietAction(stringResource(R.string.forget_link), onClick = onForget, enabled = !busy)
        }
    }
}

@Composable
private fun NearbyHubRow(hub: DiscoveredHub, selected: Boolean, onClick: () -> Unit) {
    val tint = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .clickable(remember { MutableInteractionSource() }, null, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(Modifier.size(8.dp).background(tint, CircleShape))
        Spacer(Modifier.size(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                hub.hubName,
                style = MaterialTheme.typography.titleSmall,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
            Text(
                "${hub.host}:${hub.port}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )
        }
        if (selected) {
            Text(
                stringResource(R.string.selected),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary
            )
        }
    }
}

@Composable
private fun pairingMessage(result: LinkPairResult?): String? = when (result) {
    null, LinkPairResult.Paired -> null
    is LinkPairResult.InvalidCode -> if (result.attemptsRemaining != null) {
        stringResource(R.string.pair_error_invalid_code, result.attemptsRemaining)
    } else {
        stringResource(R.string.pair_error_invalid_code_last)
    }
    LinkPairResult.Locked -> stringResource(R.string.pair_error_locked)
    LinkPairResult.Inactive -> stringResource(R.string.pair_error_inactive)
    LinkPairResult.Expired -> stringResource(R.string.pair_error_expired)
    LinkPairResult.BadRequest -> stringResource(R.string.pair_error_bad_request)
    LinkPairResult.Unreachable -> stringResource(R.string.pair_error_unreachable)
    LinkPairResult.Malformed -> stringResource(R.string.pair_error_malformed)
    LinkPairResult.InvalidLink -> stringResource(R.string.pair_error_invalid_link)
    LinkPairResult.HubMismatch -> stringResource(R.string.pair_error_hub_mismatch)
    LinkPairResult.StoreFailed -> stringResource(R.string.pair_error_store_failed)
}
