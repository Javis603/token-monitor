package com.javis.tokenmonitor.remote.data

import android.content.Context
import android.os.Build
import androidx.datastore.preferences.core.edit
import com.javis.tokenmonitor.remote.core.HubLinkBinding
import com.javis.tokenmonitor.remote.core.HubLinkBindingJson
import kotlinx.coroutines.flow.first
import java.security.SecureRandom

private val DEVICE_ID = Regex("^[A-Za-z0-9._:-]{1,64}$")
private const val DEVICE_ID_ALPHABET = "0123456789abcdef"

/**
 * Persists the device link: the binding JSON in DataStore (no secrets) and the read-only device
 * token in [SecureStore] under its own key. The legacy manual `secret` key is never touched here.
 */
class LinkStore(
    private val context: Context,
    private val secrets: SecureStore = SecureStore(context)
) {
    private val prefs = context.remoteDataStore
    private val random = SecureRandom()

    suspend fun readBinding(): HubLinkBinding? =
        HubLinkBindingJson.decode(prefs.data.first()[RemoteKeys.link])

    suspend fun writeBinding(binding: HubLinkBinding) {
        prefs.edit { it[RemoteKeys.link] = HubLinkBindingJson.encode(binding) }
    }

    suspend fun clearBinding() {
        prefs.edit { it.remove(RemoteKeys.link) }
    }

    suspend fun readLastGoodUrl(): String? =
        prefs.data.first()[RemoteKeys.linkLastUrl]?.takeIf { it.isNotBlank() }

    suspend fun writeLastGoodUrl(url: String) {
        prefs.edit { it[RemoteKeys.linkLastUrl] = url }
    }

    suspend fun clearLastGoodUrl() {
        prefs.edit { it.remove(RemoteKeys.linkLastUrl) }
    }

    /** Stable id sent as `deviceId`; generated once and reused for later pairings. */
    suspend fun ensureDeviceId(): String {
        val stored = prefs.data.first()[RemoteKeys.deviceId]
        if (stored != null && DEVICE_ID.matches(stored)) return stored
        val id = "android-" + (1..16).map { DEVICE_ID_ALPHABET[random.nextInt(16)] }.joinToString("")
        prefs.edit { it[RemoteKeys.deviceId] = id }
        return id
    }

    fun readToken(): String? = secrets.readDeviceToken()

    fun writeToken(token: String) {
        secrets.writeDeviceToken(token)
    }

    fun clearToken() {
        secrets.clearDeviceToken()
    }

    fun deviceName(): String {
        val model = Build.MODEL.orEmpty()
            .filter { it.code in 32..126 }
            .trim()
            .take(80)
        return model.ifEmpty { "Android" }
    }
}
