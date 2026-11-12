package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DiscoveryRecordTest {
    private val hubId = "fedcba9876543210"

    @Test
    fun readsTheContractTxtRecords() {
        val hub = discoveryFromService(
            serviceName = "tm-$hubId",
            host = "192.168.1.5",
            port = 17321,
            attributes = mapOf(
                "id" to hubId,
                "name" to "Studio%20Mac",
                "v" to "1",
                "addrs" to "192.168.1.5:17321,10.0.0.8:17321"
            ),
            lastSeenAt = 42L
        )!!
        assertEquals(hubId, hub.hubId)
        assertEquals("Studio Mac", hub.hubName)
        assertEquals("192.168.1.5", hub.host)
        assertEquals(17321, hub.port)
        assertEquals(listOf("192.168.1.5:17321", "10.0.0.8:17321"), hub.addresses)
        assertEquals(42L, hub.lastSeenAt)
    }

    @Test
    fun fallsBackToTheInstanceNameAndFirstAddress() {
        val hub = discoveryFromService(
            serviceName = "tm-$hubId",
            host = "",
            port = 17321,
            attributes = mapOf("addrs" to "192.168.1.5:17321"),
            lastSeenAt = 0L
        )!!
        assertEquals(hubId, hub.hubId)
        assertEquals("192.168.1.5", hub.host)
        assertEquals("192.168.1.5", hub.hubName)
    }

    @Test
    fun decodesTheEncodedTxtNameAndKeepsPlusLiteral() {
        val encoded = discoveryFromService(
            serviceName = "tm-$hubId",
            host = "192.168.1.5",
            port = 17321,
            attributes = mapOf("id" to hubId, "name" to "Studio%2BMac%20%25%20Done"),
            lastSeenAt = 0L
        )!!
        assertEquals("Studio+Mac % Done", encoded.hubName)
        val literalPlus = discoveryFromService(
            serviceName = "tm-$hubId",
            host = "192.168.1.5",
            port = 17321,
            attributes = mapOf("id" to hubId, "name" to "Studio+Mac"),
            lastSeenAt = 0L
        )!!
        assertEquals("Studio+Mac", literalPlus.hubName)
    }

    @Test
    fun dropsRecordsWithoutAnIdentityOrAddress() {
        assertNull(
            discoveryFromService(
                serviceName = "tm-nothex",
                host = "192.168.1.5",
                port = 17321,
                attributes = emptyMap(),
                lastSeenAt = 0L
            )
        )
        assertNull(
            discoveryFromService(
                serviceName = "printer",
                host = "",
                port = 17321,
                attributes = mapOf("id" to hubId),
                lastSeenAt = 0L
            )
        )
        assertNull(
            discoveryFromService(
                serviceName = "tm-$hubId",
                host = "192.168.1.5",
                port = 0,
                attributes = mapOf("id" to hubId),
                lastSeenAt = 0L
            )
        )
    }

    @Test
    fun normalizesHubIdsAndNames() {
        assertEquals(hubId, normalizeHubId(" FEDCBA9876543210 "))
        assertNull(normalizeHubId("fedcba987654321"))
        assertNull(normalizeHubId("zzzzzzzzzzzzzzzz"))
        assertEquals("One line", displayName("One%0Aline"))
        assertNull(displayName("   "))
        assertEquals(hubId, hubIdFromInstanceName("tm-$hubId"))
        assertNull(hubIdFromInstanceName("other-$hubId"))
    }
}
