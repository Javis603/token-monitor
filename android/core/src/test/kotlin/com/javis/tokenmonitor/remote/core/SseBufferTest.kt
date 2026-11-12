package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SseBufferTest {
    @Test
    fun assemblesEventsSplitAcrossChunksAndSkipsHeartbeats() {
        val buffer = SseBuffer()
        assertTrue(buffer.append(": hb\n\n").isEmpty())
        val first = buffer.append("event: snapshot\ndata: {\"type\":\"stats\",\"stats\":")
        assertTrue(first.isEmpty())
        val second = buffer.append("{\"periods\":{\"today\":{\"totalTokens\":3}}}}\n\n")
        assertEquals(1, second.size)
        assertEquals("snapshot", second.single().event)
        val outcome = classifySse(second.single().event, second.single().data)
        assertEquals(3L, (outcome as HubOutcome.Stats).snapshot.today.totalTokens)
    }
}
