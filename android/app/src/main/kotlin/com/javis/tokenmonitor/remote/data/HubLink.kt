package com.javis.tokenmonitor.remote.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import com.javis.tokenmonitor.remote.core.DiscoveredHub
import com.javis.tokenmonitor.remote.core.HubLinkBinding
import com.javis.tokenmonitor.remote.core.PairLink
import com.javis.tokenmonitor.remote.core.PairOutcome
import com.javis.tokenmonitor.remote.core.candidatesForAddresses
import com.javis.tokenmonitor.remote.core.classifyPairResponse
import com.javis.tokenmonitor.remote.core.isPairingCode
import com.javis.tokenmonitor.remote.core.mergeCandidates
import com.javis.tokenmonitor.remote.core.normalizeHubUrl
import com.javis.tokenmonitor.remote.core.orderedBaseUrls
import com.javis.tokenmonitor.remote.core.pairRequestBody
import com.javis.tokenmonitor.remote.core.parseLinkStatus
import com.javis.tokenmonitor.remote.core.parsePairLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.io.IOException
import java.time.Instant

/** A base URL plus the credential to send with it. */
data class HubConfig(val baseUrl: String, val credential: String)

sealed class LinkPairResult {
    data object Paired : LinkPairResult()
    data class InvalidCode(val attemptsRemaining: Int?) : LinkPairResult()
    data object Locked : LinkPairResult()
    data object Inactive : LinkPairResult()
    data object Expired : LinkPairResult()
    data object BadRequest : LinkPairResult()
    data object Unreachable : LinkPairResult()
    data object Malformed : LinkPairResult()
    data object InvalidLink : LinkPairResult()
    data object HubMismatch : LinkPairResult()
    data object StoreFailed : LinkPairResult()
}

/**
 * Owns the phone -> desktop link: discovery lifecycle, candidate resolution, pairing and candidate
 * refresh. The device token lives only in [SecureStore] / memory; it is never logged.
 */
class HubLink(
    context: Context,
    private val client: HubClient,
    private val store: LinkStore,
    private val discovery: LanDiscovery,
    private val onNetworkChanged: () -> Unit,
    private val onBoundHubDiscovered: () -> Unit
) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _binding = MutableStateFlow<HubLinkBinding?>(null)
    val binding: StateFlow<HubLinkBinding?> = _binding.asStateFlow()

    val nearby: StateFlow<List<DiscoveredHub>> = discovery.hubs
    val discovering: StateFlow<Boolean> = discovery.running

    @Volatile
    private var token: String? = null

    @Volatile
    private var deviceId: String = ""

    @Volatile
    private var lastGoodUrl: String? = null

    @Volatile
    private var foreground = false

    @Volatile
    private var pairingWindow = false

    @Volatile
    private var lastNetworkChangeAt = 0L

    private var networkWatchRegistered = false

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            handleNetworkChanged()
        }

        override fun onLost(network: Network) {
            handleNetworkChanged()
        }
    }

    init {
        discovery.setOnHubDiscovered { hub ->
            if (hub.hubId == _binding.value?.hubId) onBoundHubDiscovered()
        }
    }

    suspend fun load() {
        _binding.value = store.readBinding()
        token = store.readToken()
        lastGoodUrl = store.readLastGoodUrl()
        deviceId = store.ensureDeviceId()
        updateDiscovery()
    }

    /** Registered for the process lifetime; changing networks only affects a foreground session. */
    fun startNetworkWatch() {
        if (networkWatchRegistered) return
        val manager = appContext.getSystemService(ConnectivityManager::class.java) ?: return
        try {
            manager.registerDefaultNetworkCallback(networkCallback)
            networkWatchRegistered = true
        } catch (error: Exception) {
            Log.w(TAG, "network callback unavailable", error)
        }
    }

    /** Base URLs for the bound hub in contract order, with the device token attached. */
    fun configs(): List<HubConfig> {
        val current = _binding.value ?: return emptyList()
        val credential = token ?: return emptyList()
        val discovered = discovery.hubFor(current.hubId)
        return orderedBaseUrls(discovered, lastGoodUrl, current.candidates)
            .map { HubConfig(it, credential) }
    }

    fun setForeground(active: Boolean) {
        foreground = active
        updateDiscovery()
    }

    fun setPairingWindow(active: Boolean) {
        pairingWindow = active
        updateDiscovery()
    }

    fun restartDiscovery() {
        if (!discovery.running.value) return
        discovery.stop()
        scope.launch {
            // NsdManager needs a moment after stopServiceDiscovery before it can register again.
            delay(RESTART_DELAY_MS)
            if (!shouldDiscover()) return@launch
            if (discovery.start() || discovery.running.value) return@launch
            delay(RESTART_RETRY_MS)
            if (shouldDiscover() && !discovery.running.value) discovery.start()
        }
    }

    suspend fun discoverOnce(timeoutMs: Long): List<DiscoveredHub> = discovery.discoverOnce(timeoutMs)

    fun noteSuccess(baseUrl: String) {
        val normalized = normalizeHubUrl(baseUrl) ?: return
        if (normalized == lastGoodUrl) return
        lastGoodUrl = normalized
        scope.launch { store.writeLastGoodUrl(normalized) }
    }

    suspend fun pairWithCode(code: String, hub: DiscoveredHub?): LinkPairResult {
        if (hub == null || !isPairingCode(code.trim())) return LinkPairResult.InvalidLink
        val urls = orderedBaseUrls(hub, null, emptyList())
        return pairAt(urls, expectedHubId = hub.hubId, code = code.trim())
    }

    suspend fun pairWithLink(raw: String): LinkPairResult {
        val link = parsePairLink(raw) ?: return LinkPairResult.InvalidLink
        return pairWithLink(link)
    }

    suspend fun pairWithLink(link: PairLink): LinkPairResult {
        if (!isPairingCode(link.code)) return LinkPairResult.InvalidLink
        val target = DiscoveredHub(
            hubId = link.hubId,
            hubName = link.hubName,
            host = link.host,
            port = link.port,
            addresses = link.candidates,
            lastSeenAt = System.currentTimeMillis()
        )
        return pairAt(
            orderedBaseUrls(target, null, emptyList()),
            expectedHubId = link.hubId,
            code = link.code
        )
    }

    /** Refreshes name, port and candidates from `GET /api/link`. Failures are ignored. */
    suspend fun refreshFromHub(baseUrl: String) {
        val current = _binding.value ?: return
        val credential = token ?: return
        val raw = try {
            client.getQuick("$baseUrl/api/link", credential)
        } catch (_: IOException) {
            return
        }
        val status = parseLinkStatus(raw.status, raw.body) ?: return
        if (status.hub.id != current.hubId) return
        val fresh = candidatesForAddresses(status.hub.addresses, status.hub.port)
        val updated = current.copy(
            hubName = status.hub.name.ifBlank { current.hubName },
            port = status.hub.port,
            candidates = mergeCandidates(fresh, current.candidates)
        )
        if (updated != current) {
            _binding.value = updated
            store.writeBinding(updated)
        }
        noteSuccess(baseUrl)
    }

    suspend fun forgetLink() {
        store.clearBinding()
        store.clearToken()
        store.clearLastGoodUrl()
        token = null
        lastGoodUrl = null
        _binding.value = null
        updateDiscovery()
    }

    private suspend fun pairAt(
        urls: List<String>,
        expectedHubId: String,
        code: String
    ): LinkPairResult {
        if (urls.isEmpty()) return LinkPairResult.InvalidLink
        if (deviceId.isEmpty()) deviceId = store.ensureDeviceId()
        val body = pairRequestBody(code, deviceId, store.deviceName())
        var lastFailure: LinkPairResult = LinkPairResult.Unreachable
        for (baseUrl in urls) {
            val raw = try {
                client.postJson("$baseUrl/api/pair", body)
            } catch (_: IOException) {
                continue
            }
            when (val outcome = classifyPairResponse(raw.status, raw.body)) {
                is PairOutcome.Paired -> {
                    if (outcome.hub.id != expectedHubId) return LinkPairResult.HubMismatch
                    return storePair(outcome, baseUrl, expectedHubId)
                }
                is PairOutcome.InvalidCode -> lastFailure = LinkPairResult.InvalidCode(outcome.attemptsRemaining)
                PairOutcome.Locked -> lastFailure = LinkPairResult.Locked
                PairOutcome.Inactive -> lastFailure = LinkPairResult.Inactive
                PairOutcome.Expired -> lastFailure = LinkPairResult.Expired
                PairOutcome.BadRequest -> lastFailure = LinkPairResult.BadRequest
                PairOutcome.Unreachable -> lastFailure = LinkPairResult.Unreachable
                PairOutcome.Malformed -> lastFailure = LinkPairResult.Malformed
            }
        }
        return lastFailure
    }

    private suspend fun storePair(
        outcome: PairOutcome.Paired,
        baseUrl: String,
        expectedHubId: String
    ): LinkPairResult {
        val binding = HubLinkBinding(
            hubId = outcome.hub.id.ifBlank { expectedHubId },
            hubName = outcome.hub.name.ifBlank { "Token Monitor" },
            port = outcome.hub.port,
            candidates = candidatesForAddresses(outcome.hub.addresses, outcome.hub.port),
            pairedAt = Instant.now().toString()
        )
        return try {
            // Token first: a failed binding write leaves a harmless orphan token, while the
            // reverse order would expose a "linked" binding that can never authenticate.
            store.writeToken(outcome.token)
            store.writeBinding(binding)
            store.writeLastGoodUrl(baseUrl)
            token = outcome.token
            lastGoodUrl = normalizeHubUrl(baseUrl)
            _binding.value = binding
            updateDiscovery()
            LinkPairResult.Paired
        } catch (error: Exception) {
            Log.w(TAG, "could not store the link", error)
            LinkPairResult.StoreFailed
        }
    }

    private fun handleNetworkChanged() {
        val now = System.currentTimeMillis()
        if (now - lastNetworkChangeAt < NETWORK_DEBOUNCE_MS) return
        lastNetworkChangeAt = now
        if (discovery.running.value) restartDiscovery()
        onNetworkChanged()
    }

    private fun shouldDiscover(): Boolean = foreground && (pairingWindow || _binding.value != null)

    private fun updateDiscovery() {
        if (shouldDiscover()) {
            discovery.start()
        } else {
            discovery.stop()
        }
    }

    private companion object {
        const val TAG = "HubLink"
        const val RESTART_DELAY_MS = 300L
        const val RESTART_RETRY_MS = 500L
        const val NETWORK_DEBOUNCE_MS = 1_000L
    }
}
