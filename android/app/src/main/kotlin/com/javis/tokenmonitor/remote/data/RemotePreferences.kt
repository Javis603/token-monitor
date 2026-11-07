package com.javis.tokenmonitor.remote.data

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.intPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore

val Context.remoteDataStore by preferencesDataStore(name = "remote")

object RemoteKeys {
    val hubUrl = stringPreferencesKey("hub_url")
    val snapshot = stringPreferencesKey("snapshot")
    val island = booleanPreferencesKey("island")
    val failures = intPreferencesKey("failures")

    /** JSON-encoded `HubLinkBinding`; never contains the device token. */
    val link = stringPreferencesKey("hub_link")

    /** Last base URL that answered an authenticated request for the current binding. */
    val linkLastUrl = stringPreferencesKey("hub_link_last_url")

    /** Stable per-install device id used by `POST /api/pair`. */
    val deviceId = stringPreferencesKey("device_id")
}
