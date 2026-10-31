package com.javis.tokenmonitor.remote.data

import android.content.Context
import androidx.datastore.preferences.core.edit
import com.javis.tokenmonitor.remote.core.DayUsage
import com.javis.tokenmonitor.remote.core.HubFailure
import com.javis.tokenmonitor.remote.core.HubOutcome
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

    @Volatile
    private var foreground = false

    @Volatile
    private var secret: String = ""

    @Volatile
    private var failureCount = 0

    private var persistedStamp: SurfaceStamp? = null
    private var publishedStamp: SurfaceStamp? = null
    private var islandVisible = false
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
            _ready.value = true
            if (currentConfig() != null) refresh()
        }
    }

    fun setForeground(active: Boolean) {
        foreground = active
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
            apply(outcome, forceHistory = true)
            if (foreground) {
                stopStream()
                startStream()
            }
            ConnectResult.Connected
        } catch (error: Exception) {
            ConnectResult.StoreFailed(error.message ?: "keystore")
        }
    }

    suspend fun refresh(): HubFailure? {
        val config = currentConfig() ?: return null
        _refreshing.value = true
        try {
            val raw = try {
                client.get("${config.first}/api/stats", config.second)
            } catch (_: IOException) {
                apply(HubOutcome.Failure(HubFailure.Unreachable))
                return HubFailure.Unreachable
            }
            val outcome = classifyStatsResponse(raw.status, raw.body)
            apply(outcome, forceHistory = true)
            return (outcome as? HubOutcome.Failure)?.failure
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

    private fun currentConfig(): Pair<String, String>? {
        val url = _hubUrl.value
        if (url.isBlank() || secret.isBlank()) return null
        return url to secret
    }

    private fun startStream() {
        if (streamJob?.isActive == true) return
        val generation = streamGeneration
        streamJob = scope.launch {
            while (isActive && foreground && generation == streamGeneration) {
                val config = currentConfig()
                if (config == null) break
                val events = Channel<HubOutcome>(Channel.UNLIMITED)
                val applyJob = launch {
                    for (outcome in events) apply(outcome)
                }
                try {
                    client.stream("${config.first}/api/stats/stream", config.second) { outcome ->
                        events.trySend(outcome)
                    }
                } catch (error: CancellationException) {
                    events.close()
                    applyJob.cancel()
                    throw error
                } catch (_: IOException) {
                    // The next loop opens the stream again.
                } finally {
                    events.close()
                    applyJob.join()
                }
                if (!foreground || generation != streamGeneration) break
                delay(5_000)
            }
        }
    }

    private fun stopStream() {
        streamGeneration += 1
        client.cancelStream()
        streamJob?.cancel()
        streamJob = null
    }

    private suspend fun apply(outcome: HubOutcome, forceHistory: Boolean = false) {
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
        if (outcome is HubOutcome.Stats) refreshHistory(outcome.snapshot.historyRevision, forceHistory)
    }

    private fun refreshHistory(revision: String, force: Boolean) {
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
            val days = loadHistoryDays()
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

    private fun loadHistoryDays(): List<DayUsage>? {
        val config = currentConfig() ?: return null
        val raw = try {
            client.get("${config.first}/api/history", config.second)
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
}
