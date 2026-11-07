package com.javis.tokenmonitor.remote.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LinkApiTest {
    private val hubId = "0123456789abcdef"

    private val pairBody = """
        {"ok":true,"token":"tmk_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
         "hub":{"id":"$hubId","name":"Studio Mac","port":17321,"addresses":["192.168.1.5","10.0.0.8"]},
         "device":{"id":"android-abc","name":"Pixel 9"}}
    """.trimIndent()

    @Test
    fun buildsThePairRequestBody() {
        assertEquals(
            """{"code":"123456","deviceId":"android-abc","deviceName":"Pixel 9","platform":"android"}""",
            pairRequestBody("123456", "android-abc", "Pixel 9")
        )
        // Values containing JSON syntax must be escaped by the builder, not spliced in.
        val escaped = pairRequestBody("1\"2", "a\\b", "line\nbreak")
        assertTrue(escaped.contains("\"code\":\"1\\\"2\""))
        assertTrue(escaped.contains("\"deviceId\":\"a\\\\b\""))
    }

    @Test
    fun classifiesPairSuccess() {
        val outcome = classifyPairResponse(200, pairBody) as PairOutcome.Paired
        assertTrue(outcome.token.startsWith("tmk_"))
        assertEquals(hubId, outcome.hub.id)
        assertEquals("Studio Mac", outcome.hub.name)
        assertEquals(17321, outcome.hub.port)
        assertEquals(listOf("192.168.1.5", "10.0.0.8"), outcome.hub.addresses)

        val success = parsePairSuccess(200, pairBody)!!
        assertEquals("android-abc", success.deviceId)
        assertEquals("Pixel 9", success.deviceName)
    }

    @Test
    fun classifiesPairErrors() {
        assertEquals(
            PairOutcome.InvalidCode(5),
            classifyPairResponse(401, """{"error":"invalid_code","attemptsRemaining":5}""")
        )
        assertEquals(
            PairOutcome.InvalidCode(null),
            classifyPairResponse(401, """{"error":"invalid_code"}""")
        )
        assertEquals(PairOutcome.Inactive, classifyPairResponse(404, """{"error":"pairing_inactive"}"""))
        assertEquals(PairOutcome.Expired, classifyPairResponse(410, """{"error":"pairing_expired"}"""))
        assertEquals(PairOutcome.Locked, classifyPairResponse(429, """{"error":"pairing_locked"}"""))
        assertEquals(PairOutcome.BadRequest, classifyPairResponse(400, """{"error":"bad_request"}"""))
        assertEquals(PairOutcome.BadRequest, classifyPairResponse(413, """{"error":"payload_too_large"}"""))
        assertEquals(PairOutcome.Unreachable, classifyPairResponse(503, """{"error":"hub_stopping"}"""))
        assertEquals(PairOutcome.Malformed, classifyPairResponse(200, """{"ok":true}"""))
        assertEquals(PairOutcome.Malformed, classifyPairResponse(200, "not json"))
    }

    @Test
    fun requiresAValidHubIdentityInThePairResponse() {
        assertEquals(
            PairOutcome.Malformed,
            classifyPairResponse(
                200,
                """{"ok":true,"token":"tmk_x","hub":{"id":"nope","name":"x","port":1,"addresses":[]}}"""
            )
        )
        assertEquals(
            PairOutcome.Malformed,
            classifyPairResponse(200, """{"ok":true,"token":"not-a-token","hub":{"id":"$hubId","name":"x","port":1,"addresses":[]}}""")
        )
    }

    @Test
    fun parsesLinkStatus() {
        val status = parseLinkStatus(
            200,
            """{"ok":true,"hub":{"id":"$hubId","name":"Desk","port":17321,"addresses":["192.168.1.5"]},
                "role":"device","link":{"id":"android-abc","name":"Pixel 9","platform":"android","createdAt":"x"}}"""
        )!!
        assertEquals(hubId, status.hub.id)
        assertEquals("device", status.role)
        assertEquals("android-abc", status.linkId)
        assertNull(parseLinkStatus(404, """{"error":"not_found"}"""))
        assertNull(parseLinkStatus(200, "nope"))
    }

    @Test
    fun roundTripsThePersistedBinding() {
        val binding = HubLinkBinding(
            hubId = hubId,
            hubName = "Studio Mac",
            port = 17321,
            candidates = listOf("192.168.1.5:17321", "10.0.0.8:17321"),
            pairedAt = "2026-11-06T13:30:00.000Z"
        )
        val encoded = HubLinkBindingJson.encode(binding)
        assertTrue(!encoded.contains("tmk_"))
        assertEquals(binding, HubLinkBindingJson.decode(encoded))
    }

    @Test
    fun toleratesUnknownBindingKeysAndNormalizesCandidates() {
        val decoded = HubLinkBindingJson.decode(
            """{"v":99,"hubId":"$hubId","hubName":"Desk","port":17321,
                "candidates":["192.168.1.5:17321","bogus","10.0.0.8"],"pairedAt":"now","future":true}"""
        )!!
        assertEquals("Desk", decoded.hubName)
        assertEquals(listOf("192.168.1.5:17321"), decoded.candidates)
        assertNull(HubLinkBindingJson.decode(null))
        assertNull(HubLinkBindingJson.decode("{}"))
        assertNull(HubLinkBindingJson.decode("""{"hubId":"nope","port":17321}"""))
        assertNull(HubLinkBindingJson.decode("""{"hubId":"$hubId","port":0}"""))
    }

    @Test
    fun backoffGoesOneTwoFiveTenThirtyThenCapsAndResets() {
        val backoff = ReconnectBackoff()
        assertEquals(1_000L, backoff.nextDelayMs())
        assertEquals(2_000L, backoff.nextDelayMs())
        assertEquals(5_000L, backoff.nextDelayMs())
        assertEquals(10_000L, backoff.nextDelayMs())
        assertEquals(30_000L, backoff.nextDelayMs())
        assertEquals(30_000L, backoff.nextDelayMs())
        backoff.reset()
        assertEquals(1_000L, backoff.nextDelayMs())
    }

    @Test
    fun customBackoffStepsAreHonoured() {
        val backoff = ReconnectBackoff(longArrayOf(100, 200))
        assertEquals(100L, backoff.nextDelayMs())
        assertEquals(200L, backoff.nextDelayMs())
        assertEquals(200L, backoff.nextDelayMs())
    }
}
