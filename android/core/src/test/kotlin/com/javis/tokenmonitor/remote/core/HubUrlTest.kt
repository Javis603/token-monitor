package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HubUrlTest {
    @Test
    fun acceptsHttpAndHttpsOrigins() {
        assertEquals(
            "https://token-monitor-hub.example.workers.dev",
            normalizeHubUrl(" https://token-monitor-hub.example.workers.dev/ ")
        )
        assertEquals("http://192.168.1.4:17321", normalizeHubUrl("http://192.168.1.4:17321"))
    }

    @Test
    fun rejectsSecretsInTheUrl() {
        assertNull(normalizeHubUrl("https://hub.example/api/stats?secret=nope"))
        assertNull(normalizeHubUrl("https://user:secret@hub.example"))
        assertNull(normalizeHubUrl("ftp://hub.example"))
        assertNull(normalizeHubUrl(""))
    }
}
