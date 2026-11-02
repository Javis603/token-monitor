package com.javis.tokenmonitor.remote.island

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.javis.tokenmonitor.remote.MainActivity
import com.javis.tokenmonitor.remote.R
import com.javis.tokenmonitor.remote.core.Format
import com.javis.tokenmonitor.remote.core.IslandPayload
import com.javis.tokenmonitor.remote.core.StatsSnapshot

object FocusNotifications {
    private const val CHANNEL = "usage"
    private const val NOTIFICATION_ID = 42

    fun publish(context: Context, snapshot: StatsSnapshot) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        ensureChannel(context, manager)
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val protocol = focusProtocol(context)
        val tokens = Format.compactTokens(snapshot.today.totalTokens)
        val cost = Format.costUsd(snapshot.today.costUsd)
        val open = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_token)
            .setContentTitle(tokens)
            .setContentText(cost)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        val param = IslandPayload.json(snapshot, protocol)
        if (param != null) notification.extras.putString("miui.focus.param", param)
        manager.notify(NOTIFICATION_ID, notification)
    }

    fun cancel(context: Context) {
        context.getSystemService(NotificationManager::class.java)?.cancel(NOTIFICATION_ID)
    }

    private fun ensureChannel(context: Context, manager: NotificationManager) {
        val channel = NotificationChannel(
            CHANNEL,
            context.getString(R.string.notification_channel),
            NotificationManager.IMPORTANCE_LOW
        )
        channel.description = context.getString(R.string.notification_channel_description)
        channel.setShowBadge(false)
        manager.createNotificationChannel(channel)
    }

    private fun focusProtocol(context: Context): Int = try {
        Settings.System.getInt(context.contentResolver, "notification_focus_protocol", 0)
    } catch (_: Exception) {
        0
    }
}
