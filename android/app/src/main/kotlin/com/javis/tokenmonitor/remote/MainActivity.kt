package com.javis.tokenmonitor.remote

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.lifecycle.viewmodel.compose.viewModel
import com.javis.tokenmonitor.remote.ui.RemoteApp
import com.javis.tokenmonitor.remote.ui.RemoteViewModel
import com.javis.tokenmonitor.remote.ui.RemoteViewModelFactory
import kotlinx.coroutines.flow.MutableStateFlow

class MainActivity : ComponentActivity() {
    private val pairIntent = MutableStateFlow<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) readPairIntent(intent)
        val repository = (application as TokenMonitorApp).repository
        setContent {
            val model: RemoteViewModel = viewModel(factory = RemoteViewModelFactory(repository))
            val pendingLink by pairIntent.collectAsState()
            RemoteApp(model, pendingLink) { pairIntent.value = null }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        readPairIntent(intent)
    }

    private fun readPairIntent(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme?.lowercase() == "tokenmonitor") {
            pairIntent.value = data.toString()
        }
    }
}
