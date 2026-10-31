package com.javis.tokenmonitor.remote.data

import com.javis.tokenmonitor.remote.core.HubOutcome
import com.javis.tokenmonitor.remote.core.SseBuffer
import com.javis.tokenmonitor.remote.core.classifySse
import com.javis.tokenmonitor.remote.core.classifyStatsResponse
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

class HubClient {
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    private val streamHttp = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .callTimeout(0, TimeUnit.MILLISECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    @Volatile
    private var streamCall: Call? = null

    data class Raw(val status: Int, val body: String)

    fun get(url: String, secret: String?): Raw {
        val builder = Request.Builder()
            .url(url)
            .header("Accept", "application/json")
            .header("User-Agent", USER_AGENT)
        if (!secret.isNullOrEmpty()) builder.header("Authorization", "Bearer $secret")
        http.newCall(builder.build()).execute().use { response ->
            return Raw(response.code, response.body?.string().orEmpty())
        }
    }

    fun cancelStream() {
        streamCall?.cancel()
    }

    fun stream(url: String, secret: String, onEvent: (HubOutcome) -> Unit) {
        val request = Request.Builder()
            .url(url)
            .header("Accept", "text/event-stream")
            .header("Authorization", "Bearer $secret")
            .header("x-token-monitor-stream", "2")
            .header("Cache-Control", "no-cache")
            .header("User-Agent", USER_AGENT)
            .build()
        val call = streamHttp.newCall(request)
        streamCall = call
        call.execute().use { response ->
            if (!response.isSuccessful) {
                onEvent(classifyStatsResponse(response.code, response.body?.string().orEmpty()))
                return
            }
            val source = response.body?.source() ?: return
            val buffer = SseBuffer()
            while (!call.isCanceled() && !source.exhausted()) {
                val line = source.readUtf8Line() ?: break
                buffer.append(line + "\n").forEach { event ->
                    classifySse(event.event, event.data)?.let(onEvent)
                }
            }
        }
    }

    private companion object {
        const val USER_AGENT = "TokenMonitorRemote/0.1"
    }
}
