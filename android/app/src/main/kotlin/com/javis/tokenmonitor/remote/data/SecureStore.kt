@file:Suppress("DEPRECATION")

package com.javis.tokenmonitor.remote.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

// EncryptedSharedPreferences is the Jetpack API this app uses for the hub secret.

class SecureStore(context: Context) {
    private val preferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    fun read(): String? = preferences.getString(KEY, null)?.takeIf { it.isNotEmpty() }

    fun write(secret: String) {
        preferences.edit().putString(KEY, secret).commit()
    }

    private companion object {
        const val FILE = "hub_secret"
        const val KEY = "secret"
    }
}
