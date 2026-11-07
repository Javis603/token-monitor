package com.javis.tokenmonitor.remote

import android.app.Application
import android.os.Build
import java.io.File
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.javis.tokenmonitor.remote.data.HubRepository
import com.javis.tokenmonitor.remote.refresh.RefreshWorker
import java.util.concurrent.TimeUnit

class TokenMonitorApp : Application() {
    lateinit var repository: HubRepository
        private set

    override fun onCreate() {
        super.onCreate()
        if (isWidgetProviderProcess()) return
        repository = HubRepository(this)
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "hub-refresh",
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    private fun isWidgetProviderProcess(): Boolean = processName().endsWith(":widgetProvider")

    private fun processName(): String {
        if (Build.VERSION.SDK_INT >= 28) return getProcessName()
        return File("/proc/self/cmdline").readText().substringBefore('\u0000')
    }
}
