package com.javis.tokenmonitor.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.Button
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.javis.tokenmonitor.R
import com.javis.tokenmonitor.data.GatewayEndpoint
import com.javis.tokenmonitor.discovery.NsdDiscovery

// The gateway's default view-plane port, pre-filled so a manual entry usually
// only needs the address. Kept in sync with src/gateway/server.js.
private const val DEFAULT_VIEW_PORT = 17322

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GatewaysScreen(
    discovered: List<NsdDiscovery.Discovered>,
    saved: List<GatewayEndpoint>,
    onConnect: (GatewayEndpoint) -> Unit,
    onForget: (GatewayEndpoint) -> Unit,
    modifier: Modifier = Modifier
) {
    var host by rememberSaveable { mutableStateOf("") }
    var port by rememberSaveable { mutableStateOf(DEFAULT_VIEW_PORT.toString()) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }

    Scaffold(
        modifier = modifier,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = { TopAppBar(title = { Text(stringResource(R.string.gateways_title)) }) }
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            item {
                Text(
                    text = stringResource(R.string.gateways_subtitle),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            item {
                ElevatedCard(modifier = Modifier.fillMaxWidth()) {
                    Text(
                        text = stringResource(R.string.gateways_cleartext_notice),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(14.dp)
                    )
                }
            }

            item { SectionHeader(stringResource(R.string.gateways_discovered)) }

            if (discovered.isEmpty()) {
                item {
                    Text(
                        text = stringResource(R.string.gateways_discovering),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                items(items = discovered, key = { "${it.name}@${it.host}" }) { service ->
                    GatewayRow(
                        title = service.name,
                        subtitle = "${service.host}:${service.effectiveViewPort}",
                        live = true,
                        onClick = {
                            onConnect(
                                GatewayEndpoint(
                                    id = "${service.host}:${service.effectiveViewPort}",
                                    name = service.name,
                                    host = service.host,
                                    viewPort = service.effectiveViewPort,
                                    dataPort = service.dataPort
                                )
                            )
                        }
                    )
                }
            }

            if (saved.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.gateways_saved)) }
                items(items = saved, key = { it.id }) { endpoint ->
                    GatewayRow(
                        title = endpoint.label,
                        subtitle = endpoint.baseUrl,
                        onClick = { onConnect(endpoint) },
                        onForget = { onForget(endpoint) }
                    )
                }
            }

            item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    SectionHeader(stringResource(R.string.gateways_manual))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedTextField(
                            value = host,
                            onValueChange = { host = it; error = null },
                            modifier = Modifier.weight(1f),
                            label = { Text(stringResource(R.string.gateways_host_hint)) },
                            singleLine = true
                        )
                        OutlinedTextField(
                            value = port,
                            onValueChange = { port = it.filter { char -> char.isDigit() }.take(5); error = null },
                            modifier = Modifier.width(96.dp),
                            label = { Text(stringResource(R.string.gateways_port_hint)) },
                            singleLine = true
                        )
                    }
                    error?.let { message ->
                        Text(
                            text = message,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                    // Resolve once at composable scope: `onClick` is not a
                    // composable lambda, so a @Composable stringResource call
                    // inside it would be a compile error.
                    val hostBlankError = stringResource(R.string.error_host_blank)
                    val portInvalidError = stringResource(R.string.error_port_invalid)
                    Button(
                        onClick = {
                            val address = host.trim()
                            val portNumber = port.toIntOrNull()
                            when {
                                address.isBlank() -> error = hostBlankError
                                portNumber == null || portNumber !in 1..65535 ->
                                    error = portInvalidError
                                else -> {
                                    error = null
                                    onConnect(
                                        GatewayEndpoint(
                                            id = "$address:$portNumber",
                                            name = "",
                                            host = address,
                                            viewPort = portNumber
                                        )
                                    )
                                }
                            }
                        },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text(stringResource(R.string.gateways_connect))
                    }
                }
            }
        }
    }
}

@Composable
private fun GatewayRow(
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    onForget: (() -> Unit)? = null,
    live: Boolean? = null
) {
    ElevatedCard(onClick = onClick, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            if (live == true) {
                Box(
                    modifier = Modifier
                        .size(8.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.primary)
                )
            }
            Column(Modifier.weight(1f)) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            if (onForget != null) {
                IconButton(onClick = onForget) {
                    Icon(Icons.Default.Delete, contentDescription = stringResource(R.string.action_forget))
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant
    )
}
