@file:Suppress("DEPRECATION")

package com.javis.tokenmonitor.remote.data

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

// EncryptedSharedPreferences is the Jetpack API this app uses for hub credentials.

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

    /** Shared secret for the manual URL + secret path (admin credential, Worker or Node hub). */
    fun read(): String? = preferences.getString(SECRET_KEY, null)?.takeIf { it.isNotEmpty() }

    fun write(secret: String) {
        preferences.edit().putString(SECRET_KEY, secret).commit()
    }

    /** Revocable, read-only token issued by `POST /api/pair` for a linked device. */
    fun readDeviceToken(): String? = preferences.getString(DEVICE_TOKEN_KEY, null)?.takeIf { it.isNotEmpty() }

    fun writeDeviceToken(token: String) {
        preferences.edit().putString(DEVICE_TOKEN_KEY, token).commit()
    }

    fun clearDeviceToken() {
        preferences.edit().remove(DEVICE_TOKEN_KEY).commit()
    }

    private companion object {
        const val FILE = "hub_secret"
        const val SECRET_KEY = "secret"
        const val DEVICE_TOKEN_KEY = "device_token"
    }
}
