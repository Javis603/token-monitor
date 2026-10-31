package com.javis.tokenmonitor.remote.refresh

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.javis.tokenmonitor.remote.TokenMonitorApp

class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as TokenMonitorApp
        app.repository.refresh()
        return Result.success()
    }
}
