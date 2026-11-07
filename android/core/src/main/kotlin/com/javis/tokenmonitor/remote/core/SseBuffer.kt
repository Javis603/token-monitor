package com.javis.tokenmonitor.remote.core

data class SseEvent(
    val event: String,
    val data: String
)

class SseBuffer {
    private val pending = StringBuilder()

    fun append(text: String): List<SseEvent> {
        pending.append(text.replace("\r\n", "\n").replace('\r', '\n'))
        val events = mutableListOf<SseEvent>()
        while (true) {
            val splitAt = pending.indexOf("\n\n")
            if (splitAt < 0) break
            val block = pending.substring(0, splitAt)
            pending.delete(0, splitAt + 2)
            parseBlock(block)?.let(events::add)
        }
        return events
    }

    private fun parseBlock(block: String): SseEvent? {
        var event = "message"
        val data = StringBuilder()
        var dataLines = 0
        for (line in block.split('\n')) {
            if (line.isEmpty() || line.startsWith(":")) continue
            val field = line.substringBefore(':')
            val rawValue = line.substringAfter(':', "")
            val value = if (rawValue.startsWith(" ")) rawValue.drop(1) else rawValue
            when (field) {
                "event" -> event = value
                "data" -> {
                    if (dataLines > 0) data.append('\n')
                    data.append(value)
                    dataLines += 1
                }
            }
        }
        if (dataLines == 0) return null
        return SseEvent(event, data.toString())
    }
}
