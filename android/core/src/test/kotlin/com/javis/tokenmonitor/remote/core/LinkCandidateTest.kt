package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkCandidateTest {
    private val hubId = "0123456789abcdef"

    private fun discovered(host: String, port: Int = 17321, addresses: List<String> = emptyList()) =
        DiscoveredHub(hubId, "Studio Mac", host, port, addresses, 1_000L)

    @Test
    fun ordersDiscoveredThenLastGoodThenStoredCandidates() {
        val urls = orderedBaseUrls(
            discovered = discovered("192.168.1.5"),
            lastGoodUrl = "http://192.168.1.4:17321",
            candidates = listOf("10.0.0.8:17321", "192.168.1.9:17321")
        )
        assertEquals(
            listOf(
                "http://192.168.1.5:17321",
                "http://192.168.1.4:17321",
                "http://10.0.0.8:17321",
                "http://192.168.1.9:17321"
            ),
            urls
        )
    }

    @Test
    fun deduplicatesRepeatedAddresses() {
        val urls = orderedBaseUrls(
            discovered = discovered("192.168.1.5", addresses = listOf("192.168.1.5:17321")),
            lastGoodUrl = "http://192.168.1.5:17321/",
            candidates = listOf("192.168.1.5:17321")
        )
        assertEquals(listOf("http://192.168.1.5:17321"), urls)
    }

    @Test
    fun discoveredTxtAddressesFollowTheSrvResult() {
        val urls = orderedBaseUrls(
            discovered = discovered("tm-hub.local", addresses = listOf("192.168.1.5:17321")),
            lastGoodUrl = null,
            candidates = emptyList()
        )
        assertEquals(
            listOf("http://tm-hub.local:17321", "http://192.168.1.5:17321"),
            urls
        )
    }

    @Test
    fun offlineWithNothingResolvedIsEmpty() {
        assertTrue(orderedBaseUrls(null, null, emptyList()).isEmpty())
        assertTrue(orderedBaseUrls(null, "", listOf("garbage", "1.2.3.4:99999")).isEmpty())
    }

    @Test
    fun ignoresNonHttpLastGoodUrl() {
        assertTrue(orderedBaseUrls(null, "ftp://192.168.1.5:17321", emptyList()).isEmpty())
        assertTrue(orderedBaseUrls(null, "http://user:pass@192.168.1.5:17321", emptyList()).isEmpty())
    }

    @Test
    fun validatesIpv4Candidates() {
        assertEquals("192.168.1.5:17321", normalizeCandidate(" 192.168.1.5:17321 "))
        assertEquals("192.168.1.5:17321", normalizeCandidate("192.168.1.5", 17321))
        assertNull(normalizeCandidate("256.1.1.1:1"))
        assertNull(normalizeCandidate("192.168.1:1"))
        assertNull(normalizeCandidate("192.168.1.5:0"))
        assertNull(normalizeCandidate("tm-hub.local:17321"))
        assertNull(normalizeCandidate("10.0.0.8"))
        assertEquals(
            listOf("192.168.1.5:17321", "10.0.0.8:17321"),
            parseCandidateList("192.168.1.5:17321, 10.0.0.8:17321,192.168.1.5:17321")
        )
    }

    @Test
    fun newCandidatesLeadAndTheListStaysBounded() {
        val existing = (1..MAX_LINK_CANDIDATES).map { "10.0.0.$it:17321" }
        val merged = mergeCandidates(listOf("192.168.1.7:17321"), existing, limit = 3)
        assertEquals(
            listOf("192.168.1.7:17321", "10.0.0.1:17321", "10.0.0.2:17321"),
            merged
        )
        assertEquals(
            listOf("192.168.1.7:17321", "10.0.0.1:17321"),
            mergeCandidates(listOf("192.168.1.7:17321"), existing, limit = 3).take(2)
        )
    }

    @Test
    fun buildsBaseUrlsSafely() {
        assertEquals("http://192.168.1.5:17321", baseUrlFor("192.168.1.5", 17321))
        assertEquals("http://tm-hub.local:17321", baseUrlFor("tm-hub.local.", 17321))
        assertNull(baseUrlFor("", 17321))
        assertNull(baseUrlFor("user@evil", 17321))
        assertNull(baseUrlFor("192.168.1.5", 0))
    }

    @Test
    fun mapsHubAddressesToCandidates() {
        assertEquals(
            listOf("192.168.1.5:17321", "10.0.0.8:17321"),
            candidatesForAddresses(listOf("192.168.1.5", "10.0.0.8", "not-an-ip"), 17321)
        )
    }
}
