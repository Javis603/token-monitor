package com.javis.tokenmonitor.remote.data

import android.content.Context
import android.os.Build
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.javis.tokenmonitor.remote.core.DiscoveredHub
import com.javis.tokenmonitor.remote.core.discoveryFromService
import com.javis.tokenmonitor.remote.core.hubIdFromInstanceName
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.nio.charset.StandardCharsets

/**
 * DNS-SD browser for `_tokenmonitor._tcp` hubs.
 *
 * Owns the [NsdManager] registration and the Wi-Fi multicast lock for as long as discovery runs.
 * [discoverOnce] is the bounded background variant: it never leaves the lock held (unless another
 * caller already owns a running discovery). Resolves are serialized because a concurrent
 * `resolveService` call fails with `FAILURE_ALREADY_ACTIVE`.
 */
class LanDiscovery(context: Context) {
    private val appContext = context.applicationContext
    private val nsdManager: NsdManager? = appContext.getSystemService(NsdManager::class.java)
    private val multicastLock: WifiManager.MulticastLock? = try {
        appContext.getSystemService(WifiManager::class.java)
            ?.createMulticastLock(LOCK_TAG)
            ?.apply { setReferenceCounted(false) }
    } catch (error: Exception) {
        Log.w(TAG, "multicast lock unavailable", error)
        null
    }

    private val _hubs = MutableStateFlow<List<DiscoveredHub>>(emptyList())
    val hubs: StateFlow<List<DiscoveredHub>> = _hubs.asStateFlow()

    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running.asStateFlow()

    private val mainHandler = Handler(Looper.getMainLooper())
    private val lock = Any()
    private val discovered = LinkedHashMap<String, DiscoveredHub>()
    private val resolveQueue = ArrayDeque<NsdServiceInfo>()
    private var resolving = false
    private var resolveToken = 0L
    private var resolveTimeout: Runnable? = null
    private var listener: NsdManager.DiscoveryListener? = null

    @Volatile
    private var onHubDiscovered: ((DiscoveredHub) -> Unit)? = null

    fun setOnHubDiscovered(callback: ((DiscoveredHub) -> Unit)?) {
        onHubDiscovered = callback
    }

    /** The freshest mDNS view of [hubId], or null when it was not seen in the last 120 s. */
    fun hubFor(hubId: String, now: Long = System.currentTimeMillis()): DiscoveredHub? =
        synchronized(lock) { discovered[hubId]?.takeIf { now - it.lastSeenAt <= EXPIRY_MS } }

    fun snapshot(now: Long = System.currentTimeMillis()): List<DiscoveredHub> = synchronized(lock) {
        pruneLocked(now)
        publishLocked()
        _hubs.value
    }

    /** Starts browsing. Returns true when this call registered a new discovery. */
    fun start(): Boolean {
        val nsd = nsdManager ?: return false
        val discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (!isCurrent(this)) return
                enqueueResolve(serviceInfo, this)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                if (!isCurrent(this)) return
                removeService(serviceInfo.serviceName.orEmpty())
            }

            override fun onDiscoveryStopped(serviceType: String) = Unit

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "start failed: $errorCode")
                if (!isCurrent(this)) return
                clearRegistered(forceRelease = true)
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.w(TAG, "stop failed: $errorCode")
                if (!isCurrent(this)) return
                clearRegistered(forceRelease = true)
            }
        }
        synchronized(lock) {
            if (listener != null) return false
            listener = discoveryListener
        }
        return try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
            acquireMulticastLock()
            _running.value = true
            true
        } catch (error: Exception) {
            Log.w(TAG, "discoverServices failed", error)
            synchronized(lock) { if (listener === discoveryListener) listener = null }
            releaseMulticastLock()
            _running.value = false
            false
        }
    }

    /** Stops browsing and releases the multicast lock. Safe to call when not running. */
    fun stop() {
        val current = clearRegistered(forceRelease = true)
        if (current != null) {
            try {
                nsdManager?.stopServiceDiscovery(current)
            } catch (error: Exception) {
                Log.w(TAG, "stopServiceDiscovery failed", error)
            }
        }
    }

    /**
     * One-shot discovery for the WorkManager refresh: browses for [timeoutMs] and then releases the
     * NSD registration and multicast lock. When discovery is already running this waits for the
     * caller-owned browser instead of restarting it.
     */
    suspend fun discoverOnce(timeoutMs: Long): List<DiscoveredHub> {
        val owned = start()
        try {
            if (timeoutMs > 0) delay(timeoutMs)
        } finally {
            if (owned) stop()
        }
        return snapshot()
    }

    private fun enqueueResolve(info: NsdServiceInfo, source: NsdManager.DiscoveryListener) {
        val begin = synchronized(lock) {
            if (listener !== source) return
            resolveQueue.addLast(info)
            if (resolving) {
                false
            } else {
                resolving = true
                true
            }
        }
        if (begin) resolveNext(source)
    }

    private fun resolveNext(source: NsdManager.DiscoveryListener) {
        val nsd = nsdManager ?: run {
            synchronized(lock) { resolving = false }
            return
        }
        var token = 0L
        val next = synchronized(lock) {
            if (listener !== source) {
                resolving = false
                return
            }
            val info = resolveQueue.removeFirstOrNull() ?: run {
                resolving = false
                return
            }
            resolveToken += 1
            token = resolveToken
            info
        }
        val timeout = Runnable {
            Log.w(TAG, "resolve timed out for ${next.serviceName}")
            finishResolve(source, token)
        }
        val scheduled = synchronized(lock) {
            if (listener !== source) {
                false
            } else {
                resolveTimeout = timeout
                true
            }
        }
        if (!scheduled) {
            finishResolve(source, token)
            return
        }
        mainHandler.postDelayed(timeout, RESOLVE_TIMEOUT_MS)
        val resolveListener = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.d(TAG, "resolve failed for ${serviceInfo.serviceName}: $errorCode")
                finishResolve(source, token)
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                handleResolved(serviceInfo, source)
                finishResolve(source, token)
            }
        }
        try {
            nsd.resolveService(next, resolveListener)
        } catch (error: Exception) {
            Log.w(TAG, "resolveService failed", error)
            finishResolve(source, token)
        }
    }

    /**
     * A resolve callback can be lost (known NsdManager behaviour); the timeout and the callback
     * both end up here, and the token makes the second call a no-op instead of starting a
     * concurrent resolve that would fail with FAILURE_ALREADY_ACTIVE.
     */
    private fun finishResolve(source: NsdManager.DiscoveryListener, token: Long) {
        var timeout: Runnable? = null
        var current = false
        synchronized(lock) {
            if (resolveToken != token) return
            resolveToken = 0
            resolving = false
            timeout = resolveTimeout
            resolveTimeout = null
            current = listener === source
        }
        timeout?.let(mainHandler::removeCallbacks)
        if (!current) return
        resolveNext(source)
    }

    private fun handleResolved(info: NsdServiceInfo, source: NsdManager.DiscoveryListener) {
        val attributes = try {
            info.attributes.orEmpty().mapValues { (_, bytes) ->
                String(bytes, StandardCharsets.UTF_8)
            }
        } catch (error: Exception) {
            Log.d(TAG, "unreadable TXT record", error)
            emptyMap<String, String>()
        }
        val now = System.currentTimeMillis()
        val hub = discoveryFromService(
            serviceName = info.serviceName.orEmpty(),
            host = resolvedHost(info),
            port = info.port,
            attributes = attributes,
            lastSeenAt = now
        ) ?: return
        var notify: DiscoveredHub? = null
        synchronized(lock) {
            if (listener !== source) return
            val previous = discovered[hub.hubId]
            discovered[hub.hubId] = hub
            pruneLocked(now)
            publishLocked()
            val changed = previous == null ||
                previous.host != hub.host ||
                previous.port != hub.port ||
                previous.addresses != hub.addresses
            if (changed) notify = hub
        }
        notify?.let { onHubDiscovered?.invoke(it) }
    }

    /** API 34 deprecated `getHost()` in favour of `getHostAddresses()`; support both. */
    @Suppress("DEPRECATION")
    private fun resolvedHost(info: NsdServiceInfo): String {
        if (Build.VERSION.SDK_INT >= 34) {
            info.hostAddresses?.firstOrNull()?.hostAddress?.let { return it }
        }
        return info.host?.hostAddress.orEmpty()
    }

    private fun removeService(serviceName: String) {
        val hubId = hubIdFromInstanceName(serviceName) ?: return
        synchronized(lock) {
            if (discovered.remove(hubId) != null) publishLocked()
        }
    }

    private fun pruneLocked(now: Long) {
        val stale = discovered.filterValues { now - it.lastSeenAt > EXPIRY_MS }.keys
        stale.forEach(discovered::remove)
    }

    private fun publishLocked() {
        val values = discovered.values.sortedBy { it.hubName.lowercase() }
        if (values != _hubs.value) _hubs.value = values
    }

    private fun isCurrent(source: NsdManager.DiscoveryListener): Boolean =
        synchronized(lock) { listener === source }

    private fun clearRegistered(forceRelease: Boolean): NsdManager.DiscoveryListener? {
        var timeout: Runnable? = null
        val current = synchronized(lock) {
            val registered = listener
            listener = null
            resolveQueue.clear()
            resolving = false
            resolveToken = 0
            timeout = resolveTimeout
            resolveTimeout = null
            registered
        }
        timeout?.let(mainHandler::removeCallbacks)
        if (forceRelease) releaseMulticastLock()
        _running.value = false
        return current
    }

    private fun acquireMulticastLock() {
        val lock = multicastLock ?: return
        try {
            if (!lock.isHeld) lock.acquire()
        } catch (error: Exception) {
            Log.w(TAG, "multicast lock acquire failed", error)
        }
    }

    private fun releaseMulticastLock() {
        val lock = multicastLock ?: return
        try {
            if (lock.isHeld) lock.release()
        } catch (error: Exception) {
            Log.w(TAG, "multicast lock release failed", error)
        }
    }

    private companion object {
        const val TAG = "LanDiscovery"
        const val SERVICE_TYPE = "_tokenmonitor._tcp."
        const val LOCK_TAG = "tokenmonitor:mdns"
        const val EXPIRY_MS = 120_000L
        const val RESOLVE_TIMEOUT_MS = 5_000L
    }
}
