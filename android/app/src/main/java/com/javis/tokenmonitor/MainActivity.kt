package com.javis.tokenmonitor

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Insights
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.viewmodel.compose.viewModel
import com.javis.tokenmonitor.ui.DashboardScreen
import com.javis.tokenmonitor.ui.GatewaysScreen
import com.javis.tokenmonitor.ui.theme.TokenMonitorTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            TokenMonitorTheme {
                Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    TokenMonitorApp(viewModel = viewModel())
                }
            }
        }
    }
}

/**
 * The two tabs. `Overview` is the dashboard; `Gateways` is where a gateway is
 * picked or added. They are deliberately not mutually exclusive screens in a
 * NavHost — there is no back stack to model, and keeping the current gateway's
 * stream alive while the list is showing lets a user hop back without a
 * reconnect.
 */
private enum class Tab { Gateways, Overview }

@Composable
fun TokenMonitorApp(viewModel: GatewayViewModel) {
    val selected by viewModel.selected.collectAsState()
    val stats by viewModel.stats.collectAsState()
    val status by viewModel.status.collectAsState()
    val discovered by viewModel.discovered.collectAsState()
    val saved by viewModel.saved.collectAsState()

    // Open on the dashboard when a gateway is already remembered, otherwise on
    // the list. `rememberSaveable` so rotating the phone keeps the tab.
    var tab by rememberSaveable { mutableStateOf(if (selected == null) Tab.Gateways else Tab.Overview) }

    // Back from the dashboard returns to the gateway list, not to the home
    // screen — the list is the root, and a monitoring app must not look like it
    // exited when the user expected to switch gateways.
    BackHandler(enabled = tab == Tab.Overview) { tab = Tab.Gateways }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = tab == Tab.Gateways,
                    onClick = { tab = Tab.Gateways },
                    icon = { Icon(Icons.Outlined.Storage, contentDescription = null) },
                    label = { Text(stringResource(R.string.nav_gateways)) }
                )
                NavigationBarItem(
                    selected = tab == Tab.Overview,
                    onClick = { tab = Tab.Overview },
                    icon = { Icon(Icons.Outlined.Insights, contentDescription = null) },
                    label = { Text(stringResource(R.string.nav_overview)) }
                )
            }
        }
    ) { padding ->
        when (tab) {
            Tab.Gateways -> GatewaysScreen(
                discovered = discovered,
                saved = saved,
                onConnect = { endpoint ->
                    viewModel.connect(endpoint)
                    tab = Tab.Overview
                },
                onForget = viewModel::forget,
                modifier = Modifier.padding(padding)
            )
            Tab.Overview -> DashboardScreen(
                endpoint = selected,
                stats = stats,
                status = status,
                onSwitchToGateways = { tab = Tab.Gateways },
                onRefresh = viewModel::refresh,
                modifier = Modifier.padding(padding)
            )
        }
    }
}
