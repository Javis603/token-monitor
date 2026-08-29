package com.javis.tokenmonitor

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.javis.tokenmonitor.data.GatewayApi
import com.javis.tokenmonitor.data.GatewayEndpoint
import com.javis.tokenmonitor.data.GatewayStore
import com.javis.tokenmonitor.data.StatsResponse
import com.javis.tokenmonitor.discovery.NsdDiscovery
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

sealed interface ConnectionStatus {
    data object Idle : ConnectionStatus
    data object Connecting : ConnectionStatus
    data object Connected : ConnectionStatus
    data object Reconnecting : ConnectionStatus
    data class Failed(val message: String) : ConnectionStatus
}

class GatewayViewModel(application: Application) : AndroidViewModel(application) {

    private val store = GatewayStore(application.applicationContext)
    private val api = GatewayApi()
    private val discovery = NsdDiscovery(application.applicationContext)

    val saved: StateFlow<List<GatewayEndpoint>> =
        store.gateways.stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    val selected: StateFlow<GatewayEndpoint?> =
        store.selected.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    /**
     * `WhileSubscribed` rather than `Eagerly`: discovery is only useful while the
     * gateway list is on screen, and the scan is the one thing here that keeps
     * the radio busy.
     */
    val discovered: StateFlow<List<NsdDiscovery.Discovered>> =
        discovery.discover().stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())

    private val _stats = MutableStateFlow<StatsResponse?>(null)
    val stats: StateFlow<StatsResponse?> = _stats

    private val _status = MutableStateFlow<ConnectionStatus>(ConnectionStatus.Idle)
    val status: StateFlow<ConnectionStatus> = _status

    private var streamJob: Job? = null

    init {
        viewModelScope.launch {
            selected.collect { endpoint ->
                if (endpoint == null) {
                    streamJob?.cancel()
                    _stats.value = null
                    _status.value = ConnectionStatus.Idle
                } else {
                    startStream(endpoint)
                }
            }
        }
    }

    fun connect(endpoint: GatewayEndpoint) {
        viewModelScope.launch {
            store.save(endpoint)
            store.select(endpoint)
        }
    }

    fun switchGateway() {
        viewModelScope.launch { store.select(null) }
    }

    fun forget(endpoint: GatewayEndpoint) {
        viewModelScope.launch { store.forget(endpoint.id) }
    }

    fun refresh() {
        val endpoint = selected.value ?: return
        viewModelScope.launch {
            runCatching { api.stats(endpoint.baseUrl) }
                .onSuccess {
                    _stats.value = it
                    _status.value = ConnectionStatus.Connected
                }
                .onFailure { _status.value = ConnectionStatus.Failed(it.message ?: "unreachable") }
        }
    }

    /**
     * One snapshot, then the stream, then retry forever.
     *
     * The snapshot comes first so the screen has content on the first frame
     * instead of waiting for the stream's initial event, and so a gateway whose
     * stream is broken still yields a usable reading.
     *
     * Retry is unconditional and bounded only by the app being in the
     * foreground: a phone leaves and rejoins Wi-Fi constantly, and a gateway is
     * expected to disappear when its host sleeps. Both are normal, not errors.
     */
    private fun startStream(endpoint: GatewayEndpoint) {
        streamJob?.cancel()
        streamJob = viewModelScope.launch {
            while (true) {
                try {
                    _status.value = if (_stats.value == null) ConnectionStatus.Connecting
                    else ConnectionStatus.Reconnecting
                    _stats.value = api.stats(endpoint.baseUrl)
                    _status.value = ConnectionStatus.Connected
                    api.stream(endpoint.baseUrl).collect { _stats.value = it }
                } catch (t: CancellationException) {
                    // Rethrown, not swallowed: this is how cancelling the job
                    // for a different gateway actually stops the loop. Catching
                    // it as a Throwable would keep the old stream alive.
                    throw t
                } catch (t: Throwable) {
                    // Last good reading is kept on screen. Replacing it with an
                    // error state would throw away real data because a laptop
                    // closed its lid.
                    _status.value = ConnectionStatus.Failed(t.message ?: "unreachable")
                }
                delay(RECONNECT_DELAY_MS)
            }
        }
    }

    private companion object {
        const val RECONNECT_DELAY_MS = 5_000L
    }
}
