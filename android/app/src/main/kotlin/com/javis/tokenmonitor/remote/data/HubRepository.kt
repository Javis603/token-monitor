package com.javis.tokenmonitor.remote.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import com.javis.tokenmonitor.remote.core.DayUsage
import com.javis.tokenmonitor.remote.core.DiscoveredHub
import com.javis.tokenmonitor.remote.core.HubFailure
import com.javis.tokenmonitor.remote.core.HubLinkBinding
import com.javis.tokenmonitor.remote.core.HubOutcome
import com.javis.tokenmonitor.remote.core.ReconnectBackoff
import com.javis.tokenmonitor.remote.core.SnapshotJson
import com.javis.tokenmonitor.remote.core.StatsParser
import com.javis.tokenmonitor.remote.core.StatsSnapshot
import com.javis.tokenmonitor.remote.core.overlayLiveToday
import com.javis.tokenmonitor.remote.core.SurfaceStamp
import com.javis.tokenmonitor.remote.core.classifyHealth
import com.javis.tokenmonitor.remote.core.classifyStatsResponse
import com.javis.tokenmonitor.remote.core.normalizeHubUrl
import com.javis.tokenmonitor.remote.core.reduceSnapshot
import com.javis.tokenmonitor.remote.core.surfaceStamp
import com.javis.tokenmonitor.remote.island.FocusNotifications
import com.javis.tokenmonitor.remote.widget.WidgetUpdater
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException

sealed class ConnectResult {
    data object Connected : ConnectResult()
    data object InvalidUrl : ConnectResult()
    data object MissingSecret : ConnectResult()
    data class Rejected(val failure: HubFailure) : ConnectResult()
    data class StoreFailed(val message: String) : ConnectResult()
}

class HubRepository(
    private val appContext: Context,
    private val client: HubClient = HubClient(),
    private val secrets: SecureStore = SecureStore(appContext)
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val mutex = Mutex()
    private val externalMutex = Mutex()
    private val prefs = appContext.remoteDataStore

    private val linkStore = LinkStore(appContext, secrets)
    private val discovery = LanDiscovery(appContext)
    private val link = HubLink(
        context = appContext,
        client = client,
        store = linkStore,
        discovery = discovery,
        onNetworkChanged = { scope.launch { handleNetworkChanged() } },
        onBoundHubDiscovered = { scope.launch { restartStream() } }
    )

    private val _ready = MutableStateFlow(false)
    val ready: StateFlow<Boolean> = _ready

    private val _snapshot = MutableStateFlow<StatsSnapshot?>(null)
    val snapshot: StateFlow<StatsSnapshot?> = _snapshot

    private val _failure = MutableStateFlow<HubFailure?>(null)
    val failure: StateFlow<HubFailure?> = _failure

    private val _hubUrl = MutableStateFlow("")
    val hubUrl: StateFlow<String> = _hubUrl

    private val _islandEnabled = MutableStateFlow(false)
    val islandEnabled: StateFlow<Boolean> = _islandEnabled

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing

    /** Non-null once this phone is paired to a Node hub. Legacy manual config leaves it null. */
    val linkBinding: StateFlow<HubLinkBinding?> = link.binding

    /** Hubs currently advertised on the LAN (used by the pairing UI). */
    val nearby: StateFlow<List<DiscoveredHub>> = link.nearby

    val discovering: StateFlow<Boolean> = link.discovering

    @Volatile
    private var foreground = false

    @Volatile
    private var secret: String = ""

    @Volatile
    private var failureCount = 0

    @Volatile
    private var lastLinkRefreshAt = 0L

    private var persistedStamp: SurfaceStamp? = null
    private var publishedStamp: SurfaceStamp? = null
    private var islandVisible = false
    private val streamLock = Any()
    private var streamJob: Job? = null
    private var streamGeneration = 0
    private val historyLock = Any()
    private var historyJob: Job? = null
    @Volatile
    private var historyGeneration = 0
    @Volatile
    private var loadedHistoryRevision: String? = null
    @Volatile
    private var inflightHistoryRevision: String? = null

    init {
        scope.launch {
            val stored = prefs.data.first()
            secret = secrets.read().orEmpty()
            val fileSnapshot = SnapshotFile.read(appContext)
            val legacy = stored[RemoteKeys.snapshot]?.let(SnapshotJson::decode)
            val decoded = fileSnapshot ?: legacy
            if (fileSnapshot == null && decoded != null) SnapshotFile.write(appContext, decoded)
            if (stored.contains(RemoteKeys.snapshot)) {
                prefs.edit { it.remove(RemoteKeys.snapshot) }
            }
            mutex.withLock {
                if (_snapshot.value == null) _snapshot.value = decoded
            }
            externalMutex.withLock {
                if (persistedStamp == null) persistedStamp = decoded?.surfaceStamp()
            }
            _hubUrl.value = stored[RemoteKeys.hubUrl].orEmpty()
            _islandEnabled.value = stored[RemoteKeys.island] == true
            failureCount = stored[RemoteKeys.failures] ?: 0
            link.load()
            link.startNetworkWatch()
            _ready.value = true
            if (currentConfigs().isNotEmpty()) refresh()
        }
    }

    fun setForeground(active: Boolean) {
        foreground = active
        link.setForeground(active)
        if (active) {
            startStream()
        } else {
            stopStream()
            scope.launch { publishCurrent(force = true) }
        }
    }

    suspend fun connect(rawUrl: String, secret: String?): ConnectResult {
        val url = normalizeHubUrl(rawUrl) ?: return ConnectResult.InvalidUrl
        val effective = secret?.takeIf { it.isNotBlank() } ?: secrets.read()
        if (effective.isNullOrBlank()) return ConnectResult.MissingSecret
        val health = try {
            client.get("$url/api/health", null)
        } catch (_: IOException) {
            return ConnectResult.Rejected(HubFailure.Unreachable)
        }
        classifyHealth(health.status, health.body)?.let { return ConnectResult.Rejected(it) }
        val stats = try {
            client.get("$url/api/stats", effective)
        } catch (_: IOException) {
            return ConnectResult.Rejected(HubFailure.Unreachable)
        }
        val outcome = classifyStatsResponse(stats.status, stats.body)
        if (outcome is HubOutcome.Failure) return ConnectResult.Rejected(outcome.failure)
        return try {
            secrets.write(effective)
            prefs.edit { it[RemoteKeys.hubUrl] = url }
            this.secret = effective
            _hubUrl.value = url
            apply(outcome, forceHistory = true, baseUrl = url)
            if (foreground) restartStream()
            ConnectResult.Connected
        } catch (error: Exception) {
            ConnectResult.StoreFailed(error.message ?: "keystore")
        }
    }

    suspend fun refresh(): HubFailure? {
        // A worker can start before the asynchronous load finishes; wait for the first config read.
        ready.first { it }
        // A background refresh has no live mDNS browser: give discovery one bounded window, then
        // fall back to the persisted candidates. The multicast lock is released before we return.
        if (link.binding.value != null && !foreground) {
            link.discoverOnce(BACKGROUND_DISCOVERY_MS)
        }
        val configs = currentConfigs()
        if (configs.isEmpty()) {
            if (link.binding.value != null) {
                apply(HubOutcome.Failure(HubFailure.Unreachable))
                return HubFailure.Unreachable
            }
            return null
        }
        val linked = link.binding.value != null
        _refreshing.value = true
        try {
            for (config in configs) {
                val raw = try {
                    if (linked) {
                        client.getQuick("${config.baseUrl}/api/stats", config.credential)
                    } else {
                        client.get("${config.baseUrl}/api/stats", config.credential)
                    }
                } catch (_: IOException) {
                    continue
                }
                val outcome = classifyStatsResponse(raw.status, raw.body)
                apply(outcome, forceHistory = true, baseUrl = config.baseUrl)
                return (outcome as? HubOutcome.Failure)?.failure
            }
            apply(HubOutcome.Failure(HubFailure.Unreachable))
            return HubFailure.Unreachable
        } finally {
            _refreshing.value = false
        }
    }

    suspend fun setIslandEnabled(enabled: Boolean) {
        prefs.edit { it[RemoteKeys.island] = enabled }
        _islandEnabled.value = enabled
        val current = mutex.withLock { _snapshot.value }
        externalMutex.withLock {
            if (!enabled || current == null || failureCount >= 2) {
                if (islandVisible) FocusNotifications.cancel(appContext)
                islandVisible = false
                return
            }
            FocusNotifications.publish(appContext, current)
            islandVisible = true
        }
    }

    // ---------------------------------------------------------------- pairing

    fun startPairingDiscovery() {
        link.setPairingWindow(true)
    }

    fun stopPairingDiscovery() {
        link.setPairingWindow(false)
    }

    suspend fun pairWithCode(code: String, hub: DiscoveredHub?): LinkPairResult {
        val result = link.pairWithCode(code, hub)
        if (result == LinkPairResult.Paired) onPaired()
        return result
    }

    suspend fun pairWithLink(raw: String): LinkPairResult {
        val result = link.pairWithLink(raw)
        if (result == LinkPairResult.Paired) onPaired()
        return result
    }

    suspend fun forgetLink() {
        link.forgetLink()
        _failure.value = null
        lastLinkRefreshAt = 0L
        if (legacyConfig() != null) {
            if (foreground) restartStream()
            scope.launch { refresh() }
        } else {
            stopStream()
        }
    }

    private suspend fun onPaired() {
        // The phone may hold a snapshot from a previous destination. Showing it
        // while the first frame from the newly paired hub is in flight is what
        // makes the home page briefly claim that no device is online (or repeat
        // the previous connection's error). Drop it and wait for one real read.
        clearCachedSnapshot()
        lastLinkRefreshAt = 0L
        refresh()
        if (foreground) restartStream()
    }

    private suspend fun clearCachedSnapshot() {
        mutex.withLock { _snapshot.value = null }
        externalMutex.withLock {
            SnapshotFile.write(appContext, null)
            persistedStamp = null
            publishedStamp = null
        }
        _failure.value = null
        failureCount = 0
        loadedHistoryRevision = null
        inflightHistoryRevision = null
        prefs.edit { it[RemoteKeys.failures] = 0 }
    }

    // ---------------------------------------------------------------- connection

    private fun legacyConfig(): HubConfig? {
        val url = _hubUrl.value
        if (url.isBlank() || secret.isBlank()) return null
        return HubConfig(url, secret)
    }

    private fun currentConfigs(): List<HubConfig> =
        if (link.binding.value != null) link.configs() else listOfNotNull(legacyConfig())

    private fun startStream() {
        synchronized(streamLock) {
            if (streamJob?.isActive == true) return
            val generation = streamGeneration
            streamJob = scope.launch {
                val backoff = ReconnectBackoff()
                while (isActive && foreground && generation == streamGeneration) {
                    val linked = link.binding.value != null
                    val configs = currentConfigs()
                    if (configs.isEmpty() && !linked) break
                    var success = false
                    if (configs.isEmpty()) {
                        apply(HubOutcome.Failure(HubFailure.Unreachable))
                    }
                    for (config in configs) {
                        if (!isActive || !foreground || generation != streamGeneration) break
                        val events = Channel<HubOutcome>(Channel.UNLIMITED)
                        val applyJob = launch {
                            for (outcome in events) apply(outcome, baseUrl = config.baseUrl)
                        }
                        try {
                            client.stream("${config.baseUrl}/api/stats/stream", config.credential) { outcome ->
                                events.trySend(outcome)
                                if (outcome !is HubOutcome.Failure) success = true
                            }
                        } catch (error: CancellationException) {
                            events.close()
                            applyJob.cancel()
                            throw error
                        } catch (_: IOException) {
                            // The next candidate (or the next loop) opens the stream again.
                        } finally {
                            events.close()
                            applyJob.join()
                        }
                        if (success) break
                    }
                    if (!foreground || generation != streamGeneration) break
                    if (success) {
                        backoff.reset()
                        delay(RETRY_AFTER_STREAM_MS)
                    } else {
                        delay(backoff.nextDelayMs())
                    }
                }
            }
        }
    }

    private fun stopStream() {
        synchronized(streamLock) {
            streamGeneration += 1
            client.cancelStream()
            streamJob?.cancel()
            streamJob = null
        }
    }

    private fun restartStream() {
        if (!foreground) return
        stopStream()
        startStream()
    }

    private suspend fun handleNetworkChanged() {
        if (foreground) restartStream()
    }

    private fun noteLinkSuccess(baseUrl: String) {
        if (link.binding.value == null) return
        link.noteSuccess(baseUrl)
        val now = System.currentTimeMillis()
        if (now - lastLinkRefreshAt < LINK_REFRESH_INTERVAL_MS) return
        lastLinkRefreshAt = now
        scope.launch { link.refreshFromHub(baseUrl) }
    }

    private suspend fun apply(
        outcome: HubOutcome,
        forceHistory: Boolean = false,
        baseUrl: String? = null
    ) {
        val snapshot: StatsSnapshot?
        val cancel: Boolean
        mutex.withLock {
            val next = reduceSnapshot(_snapshot.value, outcome)
            _snapshot.value = next
            when (outcome) {
                is HubOutcome.Stats -> {
                    _failure.value = null
                    if (failureCount != 0) {
                        failureCount = 0
                        prefs.edit { it[RemoteKeys.failures] = 0 }
                    }
                    snapshot = next
                    cancel = false
                }
                is HubOutcome.Freshness -> {
                    snapshot = next
                    cancel = false
                }
                is HubOutcome.Failure -> {
                    _failure.value = outcome.failure
                    failureCount += 1
                    prefs.edit { it[RemoteKeys.failures] = failureCount }
                    snapshot = null
                    cancel = failureCount >= 2
                }
            }
        }
        if (cancel) {
            externalMutex.withLock {
                if (islandVisible) FocusNotifications.cancel(appContext)
                islandVisible = false
            }
            return
        }
        if (snapshot != null) publishCurrent(force = false)
        if (outcome is HubOutcome.Stats) {
            baseUrl?.let(::noteLinkSuccess)
            refreshHistory(outcome.snapshot.historyRevision, forceHistory, baseUrl)
        }
    }

    private fun refreshHistory(revision: String, force: Boolean, baseUrl: String?) {
        val key = revision.ifEmpty { "" }
        val generation = synchronized(historyLock) {
            if (!force && key.isNotEmpty() && key == loadedHistoryRevision) return
            if (!force && key.isEmpty() && loadedHistoryRevision != null) return
            if (!force && inflightHistoryRevision == key) return
            inflightHistoryRevision = key
            historyJob?.cancel()
            ++historyGeneration
        }
        historyJob = scope.launch {
            val days = loadHistoryDays(baseUrl)
            if (!isActive || generation != historyGeneration) return@launch
            if (days == null) {
                synchronized(historyLock) {
                    if (generation != historyGeneration) return@launch
                    if (inflightHistoryRevision == key) inflightHistoryRevision = null
                    loadedHistoryRevision = key.ifEmpty { "loaded" }
                }
                return@launch
            }
            val published = mutex.withLock {
                if (generation != historyGeneration) return@withLock false
                val current = _snapshot.value ?: return@withLock false
                if (key.isNotEmpty() && current.historyRevision != key) return@withLock false
                _snapshot.value = current.copy(historyDaily = days.overlayLiveToday(current.daily))
                synchronized(historyLock) {
                    if (generation == historyGeneration) {
                        loadedHistoryRevision = key.ifEmpty { "loaded" }
                        inflightHistoryRevision = null
                    }
                }
                true
            }
            if (published) publishCurrent(force = false)
        }
    }

    private fun configFor(baseUrl: String?): HubConfig? {
        val configs = currentConfigs()
        if (baseUrl == null) return configs.firstOrNull()
        return configs.firstOrNull { it.baseUrl == baseUrl } ?: configs.firstOrNull()
    }

    private fun loadHistoryDays(baseUrl: String?): List<DayUsage>? {
        val config = configFor(baseUrl) ?: return null
        val raw = try {
            client.get("${config.baseUrl}/api/history", config.credential)
        } catch (error: CancellationException) {
            throw error
        } catch (_: IOException) {
            return null
        }
        if (raw.status !in 200..299) return null
        return try {
            StatsParser.parseHistoryDays(raw.body)
        } catch (_: Exception) {
            null
        }
    }

    private suspend fun publishCurrent(force: Boolean) {
        externalMutex.withLock {
            val snapshot = _snapshot.value ?: return@withLock
            val stamp = snapshot.surfaceStamp()
            if (stamp != persistedStamp) {
                SnapshotFile.write(appContext, snapshot)
                persistedStamp = stamp
            }
            val widgetsDue = publishedStamp != stamp && (publishedStamp == null || !foreground || force)
            if (widgetsDue) {
                WidgetUpdater.update(appContext)
                publishedStamp = stamp
            }
            val showIsland = _islandEnabled.value && failureCount < 2
            if (showIsland && (!islandVisible || widgetsDue)) {
                FocusNotifications.publish(appContext, snapshot)
                islandVisible = true
            } else if (!showIsland && islandVisible) {
                FocusNotifications.cancel(appContext)
                islandVisible = false
            }
        }
    }

    private companion object {
        const val BACKGROUND_DISCOVERY_MS = 4_000L
        const val RETRY_AFTER_STREAM_MS = 1_000L
        const val LINK_REFRESH_INTERVAL_MS = 60_000L
    }
}
