package com.javis.tokenmonitor.remote

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.lifecycle.viewmodel.compose.viewModel
import com.javis.tokenmonitor.remote.ui.RemoteApp
import com.javis.tokenmonitor.remote.ui.RemoteViewModel
import com.javis.tokenmonitor.remote.ui.RemoteViewModelFactory

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val repository = (application as TokenMonitorApp).repository
        setContent {
            val model: RemoteViewModel = viewModel(factory = RemoteViewModelFactory(repository))
            RemoteApp(model)
        }
    }
}
