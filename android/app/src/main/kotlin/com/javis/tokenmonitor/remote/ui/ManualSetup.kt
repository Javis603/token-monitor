package com.javis.tokenmonitor.remote.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.javis.tokenmonitor.remote.R

/**
 * Manual Hub URL + secret entry, collapsed by default. Pairing is the primary
 * path; this stays reachable for a Cloudflare Worker or a hub that cannot be
 * discovered on the current network.
 */
@Composable
internal fun ManualSetupPanel(
    url: String,
    secret: String,
    busy: Boolean,
    error: String?,
    actionLabel: String,
    onUrlChange: (String) -> Unit,
    onSecretChange: (String) -> Unit,
    onSubmit: () -> Unit
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val chevron by animateFloatAsState(
        targetValue = if (expanded) 90f else -90f,
        animationSpec = motionTween(Motion.PressMs),
        label = "manual-setup-chevron"
    )
    GraphitePanel {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(role = Role.Button) { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(stringResource(R.string.manual_setup), style = MaterialTheme.typography.titleMedium)
                    Text(
                        stringResource(R.string.manual_setup_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Box(Modifier.size(28.dp), contentAlignment = Alignment.Center) {
                    Icon(
                        painter = painterResource(R.drawable.ic_back),
                        contentDescription = stringResource(
                            if (expanded) R.string.manual_setup_collapse else R.string.manual_setup_expand
                        ),
                        modifier = Modifier
                            .size(16.dp)
                            .rotate(chevron),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            AnimatedVisibility(
                visible = expanded,
                enter = expandVertically(animationSpec = motionTween(Motion.PageMs)) +
                    fadeIn(animationSpec = motionTween(Motion.FadeMs)),
                exit = shrinkVertically(animationSpec = motionTween(Motion.PageMs)) +
                    fadeOut(animationSpec = motionTween(Motion.FadeMs))
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    GlassField(url, onUrlChange, stringResource(R.string.hub_url))
                    GlassField(
                        secret,
                        onSecretChange,
                        stringResource(R.string.hub_secret),
                        secret = true,
                        placeholder = stringResource(R.string.secret_keep)
                    )
                    if (error != null) Text(error, color = MaterialTheme.colorScheme.error)
                    CapsuleButton(actionLabel, enabled = !busy) { onSubmit() }
                }
            }
        }
    }
}
