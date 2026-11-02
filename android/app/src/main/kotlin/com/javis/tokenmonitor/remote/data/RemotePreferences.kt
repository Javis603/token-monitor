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
}
