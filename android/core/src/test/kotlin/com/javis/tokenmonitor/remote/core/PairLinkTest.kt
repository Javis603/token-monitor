package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PairLinkTest {
    private val hubId = "0123456789abcdef"

    @Test
    fun parsesTheContractLink() {
        val link = "tokenmonitor://pair?v=1&id=$hubId&name=Studio%20Mac&code=123456" +
            "&host=192.168.1.5&port=17321&addrs=192.168.1.5%3A17321%2C10.0.0.8%3A17321"
        val parsed = parsePairLink(link)!!
        assertEquals(hubId, parsed.hubId)
        assertEquals("Studio Mac", parsed.hubName)
        assertEquals("123456", parsed.code)
        assertEquals("192.168.1.5", parsed.host)
        assertEquals(17321, parsed.port)
        assertEquals(listOf("192.168.1.5:17321", "10.0.0.8:17321"), parsed.candidates)
    }

    @Test
    fun acceptsParametersInAnyOrderAndIgnoresUnknownOnes() {
        val link = "TOKENMONITOR://pair?code=000123&port=8080&extra=1&host=hub.local" +
            "&id=$hubId&name=Desk&v=1"
        val parsed = parsePairLink(link)!!
        assertEquals("000123", parsed.code)
        assertEquals(8080, parsed.port)
        assertEquals("hub.local", parsed.host)
        assertEquals("Desk", parsed.hubName)
        assertTrue(parsed.candidates.isEmpty())
    }

    @Test
    fun toleratesMissingOptionalFields() {
        val parsed = parsePairLink("tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5&port=17321")!!
        assertEquals("Token Monitor", parsed.hubName)
        assertTrue(parsed.candidates.isEmpty())
    }

    @Test
    fun rejectsHttpAndHttpsLinks() {
        assertNull(parsePairLink("http://192.168.1.5:17321/pair?id=$hubId&code=123456"))
        assertNull(parsePairLink("https://pair?id=$hubId&code=123456"))
    }

    @Test
    fun rejectsMissingOrInvalidFields() {
        assertNull(parsePairLink(""))
        assertNull(parsePairLink("tokenmonitor://pair?id=$hubId&host=192.168.1.5&port=17321"))
        assertNull(parsePairLink("tokenmonitor://pair?code=12345&host=192.168.1.5&port=17321&id=$hubId"))
        assertNull(parsePairLink("tokenmonitor://pair?code=123456&host=192.168.1.5&port=17321"))
        assertNull(parsePairLink("tokenmonitor://pair?id=nothex&code=123456&host=192.168.1.5&port=17321"))
        assertNull(parsePairLink("tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5&port=nope"))
        assertNull(parsePairLink("tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5&port=0"))
        assertNull(parsePairLink("tokenmonitor://pair?id=$hubId&code=123456&port=17321"))
        assertNull(parsePairLink("tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5&port=17321&v=2"))
    }

    @Test
    fun rejectsLinksWithBadHosts() {
        assertNull(
            parsePairLink(
                "tokenmonitor://pair?id=$hubId&code=123456&host=user%40evil&port=17321"
            )
        )
        assertNull(
            parsePairLink(
                "tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5%2Fapi&port=17321"
            )
        )
    }

    @Test
    fun decodesEachValueExactlyOnceAndKeepsPlusLiteral() {
        val once = parsePairLink(
            "tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5&port=17321" +
                "&name=Studio%2BOne%20%25%20Done"
        )!!
        assertEquals("Studio+One % Done", once.hubName)
        val twice = parsePairLink(
            "tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5&port=17321" +
                "&name=Studio%2520Mac"
        )!!
        assertEquals("Studio%20Mac", twice.hubName)
        val plus = parsePairLink(
            "tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5&port=17321&name=Studio+Mac"
        )!!
        assertEquals("Studio+Mac", plus.hubName)
    }

    @Test
    fun keepsLeadingZerosInThePairingCode() {
        val parsed = parsePairLink(
            "tokenmonitor://pair?id=$hubId&code=000042&host=192.168.1.5&port=17321"
        )!!
        assertEquals("000042", parsed.code)
    }

    @Test
    fun dropsInvalidCandidates() {
        val parsed = parsePairLink(
            "tokenmonitor://pair?id=$hubId&code=123456&host=192.168.1.5&port=17321" +
                "&addrs=192.168.1.5%3A17321%2Cbogus%2C10.0.0.8"
        )!!
        assertEquals(listOf("192.168.1.5:17321", "10.0.0.8:17321"), parsed.candidates)
    }
}
