package com.javis.tokenmonitor.discovery

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow

/**
 * Finds gateways on the local network with the system's mDNS/DNS-SD resolver.
 *
 * The gateway advertises `_token-monitor._tcp.` with a `view` TXT key holding
 * the view-plane port, which is what the app connects to. The data-plane port
 * arrives in the SRV record and is deliberately unused.
 */
class NsdDiscovery(context: Context) {

    companion object {
        // Trailing dot: the type the gateway registers, and the form NsdManager
        // compares against.
        const val SERVICE_TYPE = "_token-monitor._tcp."
    }

    private val manager = context.applicationContext.getSystemService(Context.NSD_SERVICE) as NsdManager

    data class Discovered(
        val name: String,
        val host: String,
        val dataPort: Int,
        val viewPort: Int?,
        val deviceId: String?
    ) {
        /** Falls back to the data port, which is at least a reachable address. */
        val effectiveViewPort: Int get() = viewPort ?: dataPort
    }

    /**
     * Emits the current set of gateways whenever one appears, resolves, or goes
     * away. The scan only runs while the flow has a collector, so leaving the
     * gateway list stops discovery instead of leaving a radio warm in the
     * background.
     */
    fun discover(): Flow<List<Discovered>> = callbackFlow {
        val found = LinkedHashMap<String, Discovered>()
        // Resolve is rate-limited by the system and easy to trigger twice for
        // one service, so a name already in flight is skipped.
        val inFlight = HashSet<String>()

        fun publish() {
            trySend(found.values.sortedBy { it.name })
        }

        fun resolveListener(name: String) = object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo?, errorCode: Int) {
                synchronized(inFlight) { inFlight.remove(name) }
            }

            override fun onServiceResolved(info: NsdServiceInfo) {
                synchronized(inFlight) { inFlight.remove(name) }
                val host = info.host?.hostAddress ?: return
                val attributes = info.attributes ?: emptyMap()
                val entry = Discovered(
                    name = name,
                    host = host,
                    dataPort = info.port,
                    viewPort = attributes["view"]?.let { String(it, Charsets.UTF_8).trim().toIntOrNull() },
                    deviceId = attributes["id"]?.let { String(it, Charsets.UTF_8).trim() }
                )
                synchronized(found) { found[name] = entry }
                publish()
            }
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {
                runCatching { close(IllegalStateException("mDNS discovery failed to start (error $errorCode)")) }
            }

            override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) = Unit
            override fun onDiscoveryStarted(serviceType: String?) = Unit
            override fun onDiscoveryStopped(serviceType: String?) = Unit

            override fun onServiceFound(info: NsdServiceInfo) {
                val name = info.serviceName ?: return
                val claimed = synchronized(inFlight) { inFlight.add(name) }
                if (!claimed) return
                val started = runCatching { manager.resolveService(info, resolveListener(name)) }.isSuccess
                if (!started) synchronized(inFlight) { inFlight.remove(name) }
            }

            override fun onServiceLost(info: NsdServiceInfo) {
                val name = info.serviceName ?: return
                synchronized(found) { found.remove(name) }
                publish()
            }
        }

        val started = runCatching {
            manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
        }.isSuccess
        if (!started) {
            runCatching { close(IllegalStateException("mDNS discovery is unavailable on this device")) }
        }

        awaitClose { runCatching { manager.stopServiceDiscovery(listener) } }
    }
}
