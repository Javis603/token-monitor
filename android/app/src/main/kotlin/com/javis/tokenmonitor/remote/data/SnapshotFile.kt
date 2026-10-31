package com.javis.tokenmonitor.remote.data

import android.content.Context
import com.javis.tokenmonitor.remote.core.SnapshotJson
import com.javis.tokenmonitor.remote.core.StatsSnapshot
import java.io.File

object SnapshotFile {
    private const val NAME = "widget-snapshot.json"

    fun write(context: Context, snapshot: StatsSnapshot?) {
        val dir = context.filesDir
        val target = File(dir, NAME)
        if (snapshot == null) {
            target.delete()
            return
        }
        val temporary = File(dir, "$NAME.tmp")
        temporary.writeText(SnapshotJson.encode(snapshot))
        if (!temporary.renameTo(target)) {
            target.writeText(temporary.readText())
            temporary.delete()
        }
    }

    fun read(context: Context): StatsSnapshot? {
        val file = File(context.filesDir, NAME)
        if (!file.isFile) return null
        return SnapshotJson.decode(file.readText())
    }
}
